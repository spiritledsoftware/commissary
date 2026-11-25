/**
 * GitHub Copilot executor (`copilot`): a signed-in Copilot account serves the Copilot CLI's preset models, each through
 * the endpoint its CLI profile names (`routes.ts`):
 *  - Chat Completions (`/chat/completions`, Gemini and Kimi models): the client mode upstream, the openai-compat
 *    stream reader;
 *  - Messages (`/v1/messages`, Claude models): Claude clients get the client mode, others a streamed answer (the
 *    Claude response translators read events), the Claude stream reader;
 *  - Responses (`/responses`, GPT, Grok and MAI models): the Codex translators and the shared Responses shaping, always
 *    streamed upstream and collected for non-stream clients (`helps/responses-request.ts`, `helps/responses-sse.ts`).
 * Every request goes only to the credential's trusted `base_url` (re-checked with `isTrustedCopilotApi` before each
 * send) with the short-lived Copilot token, which the refresh machinery renews from the GitHub token
 * (`credentials/refresh/copilot.ts`). Token counting is local, in the client's format (Gemini: `totalTokens`).
 *
 * Go source: internal/runtime/executor/copilot_executor.go (`prepare`, `send`, `CountTokens`, b824c052),
 * copilot_executor_response.go (`Execute`, `ExecuteStream`, `copilotStream`: 9792ac28 translates typed events,
 * 20211183 gives the OpenAI -> Claude stream translator the stream hint). Deliberate differences (docs/ARCHITECTURE.md,
 * "GitHub Copilot"): the preset routes only (no account `/models` discovery), no in-memory turn links and no
 * server-side replay of private reasoning (the turn ids are derived, `request.ts`), Responses always stream upstream
 * and its requests are Codex-translated, and Home dispatch is not ported.
 */
import { Clock, Effect, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import {
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  builtinTranslators,
  claudeInputTokensJson,
  geminiTokenCountJson,
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { EntryOnlyFormats, type Format, Formats } from "@commissary/translation/formats";
import { splitLines } from "@commissary/translation/sse";
import { extractTranslatedReasoningEffort, parseSuffix } from "@commissary/translation/thinking";
import {
  countClaudeInputTokens,
  encodingForModel,
  getCodec,
} from "@commissary/translation/tokenizer";
import { isTrustedCopilotApi } from "../../oauth/flows/copilot.ts";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
  type UsageDetail,
} from "../../usage/record.ts";
import {
  injectMessagesCacheControl,
  injectSystemCacheControl,
  injectToolsCacheControl,
  shouldEnsureCacheControl,
  stripPromptCacheOptions,
} from "../claude/cache-control.ts";
import { ClaudeStreamReader, validateClaudeStreamingResponse } from "../claude/stream.ts";
import { mergeUsage, parseClaudeStreamUsage, parseClaudeUsage } from "../claude/usage.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { ExecutionError, headersRecord, notImplemented } from "../errors.ts";
import { finalizePayload } from "../helps/payload.ts";
import { prepareResponsesRequest } from "../helps/responses-request.ts";
import {
  collectResponsesSse,
  type ResponsesSseInput,
  streamResponsesSse,
} from "../helps/responses-sse.ts";
import { openAICompatRetryAfterMs } from "../helps/retry-after.ts";
import {
  buildOpenAIUsageJson,
  countCodexInputTokens,
  countOpenAIChatTokens,
} from "../helps/token-count.ts";
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { OpenAICompatStreamReader, TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
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
  copilotHeaders,
  copilotResponseError,
  copilotTurnIds,
  type CopilotTurnIds,
  dropSynthesizedUserId,
  normalizeCopilotRequest,
  normalizeCopilotResponses,
  parseCopilotTurnInput,
  seedCopilotDefaults,
  visibleChatReasoning,
} from "./request.ts";
import {
  COPILOT_PROVIDER,
  copilotNativeModel,
  type CopilotRoute,
  resolveCopilotRoute,
} from "./routes.ts";

export interface CopilotExecutorOptions {
  readonly translators?: TranslatorRegistry;
}

const UNSUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  EntryOnlyFormats.OpenAIImage,
  EntryOnlyFormats.OpenAIVideo,
  EntryOnlyFormats.OpenAISpeech,
  EntryOnlyFormats.CodexAlphaSearch,
]);

const STALL_MESSAGE = "copilot: upstream stream ended before a terminal event";

/** Everything one attempt needs: the route, the trusted origin and token, and the turn identity. */
interface CopilotAttempt {
  readonly registry: TranslatorRegistry;
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly route: CopilotRoute;
  /** The credential's trusted API origin, without a trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly initiator: "user" | "agent";
  readonly ids: CopilotTurnIds;
}

const str = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

const requestError = (status: number, message: string) =>
  new ExecutionError({ status, message, requestScoped: true });

/** The model the client asked for (payload rules). */
const requestedModelOf = (attempt: CopilotAttempt): string =>
  attempt.options.metadata.requestedModel !== ""
    ? attempt.options.metadata.requestedModel
    : attempt.request.model;

/** `prepare`'s checks and `resolveRoute`: the route, the trusted credential and the turn identity of an attempt. */
const resolveAttempt = (
  registry: TranslatorRegistry,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
): Effect.Effect<CopilotAttempt, ExecutionError> =>
  Effect.gen(function* () {
    const from = options.sourceFormat;

    if (UNSUPPORTED_FORMATS.has(from) || from === EntryOnlyFormats.SystemOne)
      return yield* notImplemented(`copilot does not support ${from}`);

    if (options.alt === "responses/compact")
      return yield* requestError(
        400,
        "copilot: unsupported request or response protocol for this model",
      );

    const model = copilotNativeModel(parseSuffix(request.model).modelName);
    const route = resolveCopilotRoute(model, request.modelInfo);

    if (route === undefined)
      return yield* new ExecutionError({
        status: 404,
        message: "copilot: no supported endpoint for this model and account",
      });

    if (
      (from === Formats.OpenAIResponse || from === Formats.Codex) &&
      route.format !== Formats.OpenAIResponse &&
      str(get(request.payload, "previous_response_id")) !== ""
    ) {
      return yield* requestError(
        400,
        "copilot: this model cannot resolve previous_response_id; resend the full conversation history without previous_response_id",
      );
    }

    const { metadata } = context.credential;
    const baseUrl = str(metadata.base_url).replace(/\/+$/, "");
    const token = str(metadata.access_token);

    if (token === "" || !isTrustedCopilotApi(baseUrl))
      return yield* new ExecutionError({
        status: 401,
        message: "copilot: missing usable credentials",
      });
    const turn = parseCopilotTurnInput(options.originalRequest ?? request.payload, from);

    const ids = copilotTurnIds({
      credentialId: context.credential.id,
      callerScope: options.metadata.callerScope,
      sessionId: options.metadata.sessionId ?? options.metadata.derivedSessionId,
      history: turn.history,
    });

    return {
      registry,
      context,
      request,
      options,
      route,
      baseUrl,
      token,
      initiator: turn.initiator,
      ids,
    };
  });

/** The client body as a JSON object (every protocol Copilot takes is one). */
const asObject = (body: Json): Effect.Effect<JsonObject, ExecutionError> =>
  isJsonObject(body)
    ? Effect.succeed(body)
    : Effect.fail(requestError(400, "copilot: invalid request payload"));

/**
 * Translation to the route's protocol, the CLI defaults and the thinking pipeline (Chat Completions and Messages):
 * the body before the protocol fixes, and the original request translated the same way (payload-rule context).
 */
const translateForCopilot = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  stream: boolean,
  upstreamStream: boolean,
) {
  const { registry, context, request, options, route } = attempt;
  const thinking = yield* Thinking;
  const from = options.sourceFormat;
  const to = route.format;

  const translate = (payload: Json) =>
    translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: route.model, stream, body: payload },
      thinking.summary,
      { headers: options.headers, config: context.config, isCompat: modelIsCompat(request) },
    );

  const translated = translate(request.payload);

  if (translated.error !== undefined)
    return yield* requestError(translated.error.status, translated.error.message);

  const original =
    options.originalRequest === undefined || options.originalRequest === request.payload
      ? cloneJson(translated.body)
      : translate(options.originalRequest).body;

  const body = yield* asObject(translated.body);
  body.model = route.model;

  if (to === Formats.Claude) dropSynthesizedUserId(body, request.payload, from);

  seedCopilotDefaults(body, {
    route,
    source: request.payload,
    from,
    suffixed: parseSuffix(request.model).hasSuffix,
    upstreamStream,
  });

  const applied = yield* thinking.apply({
    body,
    model: request.model,
    from,
    to,
    provider: COPILOT_PROVIDER,
    source: request.payload,
    ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup,
  });

  return { body: yield* asObject(applied), original };
});

/** User payload rules: the final semantic mutation of the business payload (AGENTS.md). */
const finalizeForCopilot = (attempt: CopilotAttempt, original: Json, body: Json): Json =>
  finalizePayload(
    attempt.context.config,
    COPILOT_PROVIDER,
    {
      model: attempt.route.model,
      requestedModel: requestedModelOf(attempt),
      protocol: attempt.route.format,
      fromProtocol: attempt.options.sourceFormat,
      requestPath: attempt.options.metadata.requestPath,
      headers: attempt.options.headers,
      original,
    },
    body,
    attempt.context.usage,
  );

/** The body after the payload rules must still be in the mode the answer is read in. */
const checkStreamMode = (body: Json, stream: boolean): Effect.Effect<void, ExecutionError> =>
  (get(body, "stream") === true) === stream
    ? Effect.void
    : Effect.fail(
        requestError(
          400,
          "copilot: payload stream mode does not match the requested response mode",
        ),
      );

/** Chat Completions body (payload rules last). */
const prepareChatBody = Effect.fnUntraced(function* (attempt: CopilotAttempt, stream: boolean) {
  const { body, original } = yield* translateForCopilot(attempt, stream, stream);
  normalizeCopilotRequest(
    body,
    attempt.route,
    attempt.options.sourceFormat,
    attempt.request.payload,
    stream,
  );
  attempt.context.usage.setReasoningEffort(str(body.reasoning_effort) || undefined);

  return finalizeForCopilot(attempt, original, body);
});

/** Messages body: protocol fixes, cache breakpoints, then the payload rules. */
const prepareMessagesBody = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  stream: boolean,
  countOnly = false,
) {
  const { request, options, route } = attempt;
  const { body, original } = yield* translateForCopilot(attempt, stream, stream);
  normalizeCopilotRequest(body, route, options.sourceFormat, request.payload, stream);

  if (shouldEnsureCacheControl(body, false, false, request.payload, options.originalRequest)) {
    // Unlike Claude Code, Copilot also marks the tools when a system prompt exists.
    injectToolsCacheControl(body);
    injectSystemCacheControl(body);
    injectMessagesCacheControl(body);
  }

  stripPromptCacheOptions(body);
  const final = finalizeForCopilot(attempt, original, body);
  const effort = extractTranslatedReasoningEffort(final, Formats.Claude);
  attempt.context.usage.setReasoningEffort(effort !== "" ? effort : undefined);

  if (
    !countOnly &&
    !stream &&
    route.nonStreamingOutput > 0 &&
    typeof get(final, "max_tokens") === "number" &&
    Number(get(final, "max_tokens")) > route.nonStreamingOutput
  ) {
    return yield* requestError(
      400,
      `copilot: max_tokens exceeds this model's non-streaming limit of ${route.nonStreamingOutput}; lower max_tokens or enable streaming`,
    );
  }

  return final;
});

/** Responses shaping: the Codex translators, the shared Responses steps and Copilot's protocol fixes. */
const prepareResponses = (attempt: CopilotAttempt, stream: boolean) => {
  const { registry, context, request, options, route } = attempt;

  return prepareResponsesRequest(
    registry,
    context,
    request,
    options,
    {
      provider: COPILOT_PROVIDER,
      payloadProtocol: Formats.OpenAIResponse,
      signatureTargetModel: () => route.model,
      prepareTools: (body) => {
        if (!isJsonObject(body)) return body;
        body.model = route.model;
        seedCopilotDefaults(body, {
          route,
          source: request.payload,
          from: options.sourceFormat,
          suffixed: parseSuffix(request.model).hasSuffix,
          upstreamStream: true,
        });
        normalizeCopilotResponses(body, route, options.sourceFormat, request.payload);

        return body;
      },
    },
    stream,
  );
};

/** Posts the body to the credential's trusted origin; non-2xx answers become `ExecutionError`s. */
const send = Effect.fnUntraced(function* (attempt: CopilotAttempt, body: Json) {
  const { context, route } = attempt;

  // Re-checked at the send: an inference credential only ever goes to the account's trusted origin.
  if (!isTrustedCopilotApi(attempt.baseUrl))
    return yield* new ExecutionError({
      status: 401,
      message: "copilot: missing trusted API endpoint",
    });
  const client = yield* HttpClient.HttpClient;

  const headers = copilotHeaders({
    route,
    body,
    initiator: attempt.initiator,
    ids: attempt.ids,
    token: attempt.token,
  });

  const request = HttpClientRequest.post(`${attempt.baseUrl}${route.endpoint}`).pipe(
    HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
    HttpClientRequest.setHeaders(headers),
  );

  const response = yield* client
    .execute(request)
    .pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(transportError),
    );

  context.usage.markFirstByte(yield* Clock.currentTimeMillis);

  if (response.status >= 200 && response.status < 300) return response;
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
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
});

/**
 * The translators' response context. 20211183: a streamed answer always gives the OpenAI -> Claude translator the
 * stream hint, even when the client's body said `stream: false` or nothing.
 */
const responseContext = (
  attempt: CopilotAttempt,
  translated: Json,
  stream: boolean,
): ResponseContext => {
  const original = attempt.options.originalRequest ?? attempt.request.payload;

  const streamHinted =
    stream &&
    attempt.route.format === Formats.OpenAI &&
    responseFormatOf(attempt.options) === Formats.Claude &&
    get(original, "stream") !== true &&
    isJsonObject(original)
      ? { ...original, stream: true }
      : original;

  return {
    model: attempt.request.model,
    originalRequest: streamHinted,
    translatedRequest: translated,
    state: makeTranslationState(),
  };
};

const failed = (attempt: CopilotAttempt, error: ExecutionError) => {
  attempt.context.usage.fail(error.status, error.message);

  return Effect.fail(error);
};

// --- Chat Completions ----------------------------------------------------------------------------------------------

const executeChat = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const body = yield* prepareChatBody(attempt, false);
  yield* checkStreamMode(body, false);
  const response = yield* send(attempt, body);
  const text = yield* response.text.pipe(Effect.mapError(transportError));

  if (tryParseJson(text) === undefined)
    return yield* failed(
      attempt,
      new ExecutionError({ status: 502, message: "copilot: invalid upstream JSON response" }),
    );
  const upstreamError = copilotResponseError(text);

  if (upstreamError !== undefined) return yield* failed(attempt, upstreamError);
  context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));

  const out = registry.translateNonStream(
    responseFormat,
    Formats.OpenAI,
    responseContext(attempt, body, false),
    responseFormat === Formats.OpenAI ? text : visibleChatReasoning(text, "message"),
  );

  if (out === undefined || out === "")
    return yield* failed(
      attempt,
      new ExecutionError({
        status: 502,
        message: "copilot: unable to translate upstream response",
      }),
    );
  context.usage.publish(parseOpenAIUsage(text));

  return {
    payload: responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out,
    headers: new Headers(response.headers),
  } satisfies ExecutorResponse;
});

/** Each upstream SSE line, with Copilot's error frames failing the stream (`copilotResponseError`). */
const upstreamLines = (
  attempt: CopilotAttempt,
  response: { readonly stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError> },
) =>
  splitLines(response.stream).pipe(
    Stream.mapError(transportError),
    Stream.mapEffect((line) => {
      const trimmed = line.trim();

      if (!trimmed.startsWith("data:")) return Effect.succeed(line);
      const data = trimmed.slice(5).trim();

      if (data === "" || data === "[DONE]") return Effect.succeed(line);

      if (tryParseJson(data) === undefined)
        return Effect.fail(
          new ExecutionError({ status: 502, message: "copilot: invalid SSE data" }),
        );
      const upstreamError = copilotResponseError(data);

      return upstreamError === undefined ? Effect.succeed(line) : Effect.fail(upstreamError);
    }),
  );

const executeChatStream = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const body = yield* prepareChatBody(attempt, true);
  yield* checkStreamMode(body, true);
  const response = yield* send(attempt, body);

  const reader = new OpenAICompatStreamReader({
    registry,
    responseFormat,
    providerFormat: Formats.OpenAI,
    context: responseContext(attempt, body, true),
  });

  const visible = (line: string): string => {
    const trimmed = line.trim();

    if (responseFormat === Formats.OpenAI || !trimmed.startsWith("data:")) return line;
    const data = trimmed.slice(5).trim();
    const shown = visibleChatReasoning(data, "delta");

    return shown === data ? line : `data: ${shown}`;
  };

  const chunks = upstreamLines(attempt, response).pipe(
    Stream.mapAccum(
      () => reader,
      (state, line: string) => {
        const usage = parseOpenAIStreamUsage(line);

        if (usage !== undefined) context.usage.publish(usage);
        context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));

        return [state, [state.push(visible(line))]] as const;
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
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
});

// --- Messages ------------------------------------------------------------------------------------------------------

/**
 * Non-stream answer. Claude clients get the upstream JSON; other clients read a streamed answer (the Claude
 * translators expect the event sequence), validated and translated in one piece.
 */
const executeMessages = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const upstreamStream = responseFormat !== Formats.Claude;
  const body = yield* prepareMessagesBody(attempt, upstreamStream);
  yield* checkStreamMode(body, upstreamStream);
  const response = yield* send(attempt, body);
  const data = yield* response.text.pipe(Effect.mapError(transportError));
  let usage: UsageDetail | undefined;

  if (upstreamStream) {
    const invalid = validateClaudeStreamingResponse(data);

    if (invalid !== undefined)
      return yield* failed(attempt, new ExecutionError({ status: 502, message: invalid }));

    for (const line of data.split("\n")) {
      const parsed = parseClaudeStreamUsage(line);

      if (parsed !== undefined) usage = mergeUsage(usage, parsed);
      const trimmed = line.trim();

      if (trimmed.startsWith("data:"))
        context.usage.observeResponseModel(responseModelOf(tryParseJson(trimmed.slice(5).trim())));
    }
  } else {
    if (tryParseJson(data) === undefined)
      return yield* failed(
        attempt,
        new ExecutionError({ status: 502, message: "copilot: invalid upstream JSON response" }),
      );
    const upstreamError = copilotResponseError(data);

    if (upstreamError !== undefined) return yield* failed(attempt, upstreamError);
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
    usage = parseClaudeUsage(data);
  }

  const out = registry.translateNonStream(
    responseFormat,
    Formats.Claude,
    responseContext(attempt, body, upstreamStream),
    data,
  );

  if (out === undefined || out === "")
    return yield* failed(
      attempt,
      new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE }),
    );

  if (usage !== undefined) context.usage.publish(usage);

  return {
    payload: responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out,
    headers: new Headers(response.headers),
  } satisfies ExecutorResponse;
});

const executeMessagesStream = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const body = yield* prepareMessagesBody(attempt, true);
  yield* checkStreamMode(body, true);
  const response = yield* send(attempt, body);

  const reader = new ClaudeStreamReader({
    registry,
    responseFormat: responseFormatOf(options),
    context: responseContext(attempt, body, true),
    reverseMap: new Map(),
    onUsage: (detail) => context.usage.publish(detail),
    onResponseModel: (model) => context.usage.observeResponseModel(model),
  });

  const chunks = upstreamLines(attempt, response).pipe(
    Stream.mapAccum(
      () => reader,
      (state, line: string) => [state, [state.push(line)]] as const,
      { onHalt: (state) => [state.end()] },
    ),
    Stream.takeUntil((step) => step.stop),
    Stream.flatMap((step) => {
      const emitted = Stream.fromIterable(step.chunks);

      if (step.error === undefined) return emitted;
      const error = step.error;
      context.usage.fail(error.status, error.message);

      return Stream.concat(emitted, Stream.fail(error));
    }),
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
});

// --- Responses -----------------------------------------------------------------------------------------------------

const sendResponses = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const prepared = yield* prepareResponses(attempt, true);
  yield* checkStreamMode(prepared.body, true);
  const effort = str(get(prepared.body, "reasoning.effort"));
  attempt.context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
  const response = yield* send(attempt, prepared.body);

  return {
    registry: attempt.registry,
    context: attempt.context,
    request: attempt.request,
    options: attempt.options,
    prepared,
    response,
    eventError: (_event, payload) => copilotResponseError(payload),
    stallMessage: STALL_MESSAGE,
  } satisfies ResponsesSseInput;
});

// --- token counting ------------------------------------------------------------------------------------------------

/** b824c052: the count in the client's format (Gemini `totalTokens`, Claude and Responses `input_tokens`). */
const tokenCountPayload = (format: Format, count: number): string => {
  switch (format) {
    case Formats.Gemini:
      return geminiTokenCountJson(count);
    case Formats.Claude:
    case Formats.OpenAIResponse:
      return claudeInputTokensJson(count);
    default:
      return buildOpenAIUsageJson(count);
  }
};

const countTokensOf = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { route } = attempt;
  let count: number;

  switch (route.format) {
    case Formats.Claude:
      count = countClaudeInputTokens(yield* prepareMessagesBody(attempt, false, true));
      break;
    case Formats.OpenAIResponse:
      count = countCodexInputTokens(
        getCodec(encodingForModel(route.model)),
        (yield* prepareResponses(attempt, false)).body,
      );
      break;
    default:
      count = countOpenAIChatTokens(
        getCodec(encodingForModel(route.model)),
        yield* prepareChatBody(attempt, false),
      );
  }

  return {
    payload: tokenCountPayload(responseFormatOf(attempt.options), count),
    headers: new Headers({ "x-cpa-token-count": "estimated" }),
  } satisfies ExecutorResponse;
});

export const makeCopilotExecutor = (
  executorOptions: CopilotExecutorOptions = {},
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolveAttempt(registry, context, request, options);

    switch (attempt.route.format) {
      case Formats.OpenAI:
        return yield* executeChat(attempt);
      case Formats.Claude:
        return yield* executeMessages(attempt);
      case Formats.OpenAIResponse:
        return yield* collectResponsesSse(yield* sendResponses(attempt));
    }
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolveAttempt(registry, context, request, options);

    switch (attempt.route.format) {
      case Formats.OpenAI:
        return yield* executeChatStream(attempt);
      case Formats.Claude:
        return yield* executeMessagesStream(attempt);
      case Formats.OpenAIResponse:
        return streamResponsesSse(yield* sendResponses(attempt));
    }
  });

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    return yield* countTokensOf(yield* resolveAttempt(registry, context, request, options));
  });

  return { identifier: COPILOT_PROVIDER, execute, executeStream, countTokens };
};

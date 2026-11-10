/**
 * Shared engine of the Google executors (`gemini`, `gemini-interactions`, `vertex`).
 *
 * Go source: internal/runtime/executor/gemini_executor.go (Execute, ExecuteStream, CountTokens, executeInteractions,
 * executeInteractionsStream), internal/runtime/executor/gemini_vertex_executor.go (the service-account and provider-key
 * variants), internal/runtime/executor/helps/gemini_interactions.go. The two Go executors share one pipeline per
 * attempt, in the canonical order of ARCHITECTURE.md: translate -> Thinking hook -> provider shaping -> payload rules
 * (always last) -> HttpClient -> response translation.
 *
 * Differences from Go: stream lines are always reduced to their JSON payload before translation (Go's Vertex path
 * hands raw `data:` lines to the translators), usage v2 breakdowns are not ported, and Imagen requests without a prompt answer 400.
 */
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { applyPayloadRules } from "../../config/payload/index.ts";
import { asInt, del, get, type Json, type JsonObject, set, tryParseJson } from "@commissary/json";
import { splitLines } from "@commissary/translation/sse";
import {
  builtinTranslators,
  makeTranslationState,
  type RequestEnvelope,
  type ResponseContext,
  type TranslatorRegistry,
  sanitizeGeminiRequestThoughtSignatures,
  withModelInfoLookup,
  withReplayCache,
  textSignatureKeys,
} from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { responseModelOf } from "../../usage/record.ts";
import { ExecutionError, headersRecord, notImplemented } from "../errors.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
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
import {
  type ContinuationStore,
  defaultContinuationStore,
  type InteractionsState,
  prepareAntigravityInteractions,
} from "./antigravity-interactions.ts";
import { makeRequestReplayCache, type RequestReplayCache } from "./replay.ts";
import {
  ensureGeminiBoundaryUserContent,
  ensureGeminiLeadingUserContent,
  ensureGeminiTrailingUserContent,
} from "./content-turns.ts";
import {
  applyInteractionsRevisionHeaders,
  capGeminiMaxOutputTokens,
  fixGeminiImageAspectRatio,
  interactionsSseDone,
  interactionsSsePayload,
  sanitizeGeminiInteractionsUnsupportedInputIds,
  stripVertexOpenAIResponsesToolCallIds,
} from "./shaping.ts";
import {
  filterSseUsageMetadata,
  jsonPayload,
  parseGeminiStreamUsage,
  parseGeminiUsageBody,
  parseInteractionsStreamUsage,
  parseInteractionsUsageBody,
} from "./usage.ts";

export type GoogleAction = "generateContent" | "streamGenerateContent" | "countTokens" | "predict";

/** Where and how one attempt talks to Google. */
export interface GoogleTarget {
  /** Absolute URL without query string. */
  readonly url: (action: GoogleAction, model: string) => string;
  /** Native Interactions endpoint (`stream` adds the SSE query where the provider needs it). */
  readonly interactionsUrl: (stream: boolean) => string;
  /** Auth headers (`x-goog-api-key` or `Authorization`). */
  readonly authHeaders: Readonly<Record<string, string>>;
}

/** Provider specifics of one executor. */
export interface GoogleVariant {
  /** Executor identifier and thinking provider key. */
  readonly identifier: string;
  readonly vertex: boolean;
  /** Resolves the endpoint and credentials of an attempt. */
  readonly resolveTarget: (
    context: ExecutionContext,
    options: ExecutorOptions,
  ) => Effect.Effect<GoogleTarget, ExecutionError>;
  /** Whether this attempt uses the native Interactions endpoint. */
  readonly nativeInteractions: (context: ExecutionContext, options: ExecutorOptions) => boolean;
  readonly translators?: TranslatorRegistry;
  /** Antigravity Interactions continuation sessions (defaults to the `SessionState` Durable Object). */
  readonly continuations?: ContinuationStore;
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

const toExecutionError = (status: number, text: string, headers: Headers): ExecutionError =>
  new ExecutionError({
    status,
    message: text,
    headers: headersRecord(headers),
    // A rejected credential is credential-scoped: the conductor rotates/cools it down.
    ...(status === 401 ? { credentialScoped: true } : {}),
  });

/** `isImagenModel`. */
export const isImagenModel = (model: string): boolean => model.toLowerCase().includes("imagen");

interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Final business payload (after payload rules). */
  readonly body: Json;
  readonly baseModel: string;
  readonly to: string;
  readonly imagen: boolean;
  /** Format of the upstream (`gemini` or `interactions`). */
  readonly providerFormat: string;
  /** Antigravity Interactions continuation state of the request (native Interactions only). */
  readonly continuation?: InteractionsState;
}

/** Everything `prepare*` needs about the attempt. */
interface Attempt {
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly target: GoogleTarget;
  /** Text-signature cache of the request (`SessionState` backed), see `replay.ts`. */
  readonly replay: RequestReplayCache;
}

/**
 * Runs one synchronous translator call with the attempt's text-signature cache and model lookup (the Gemini
 * translators read a model's thinking budget and web search support through it).
 */
const translating = <T>(attempt: Attempt, run: () => T): T =>
  withReplayCache(attempt.replay, () => withModelInfoLookup(attempt.request.modelLookup, run));

const requestError = (envelope: RequestEnvelope) =>
  new ExecutionError({
    status: envelope.error?.status ?? 400,
    message: envelope.error?.message ?? "invalid request",
    requestScoped: true,
  });

/** Go `convertToImagenRequest`: Gemini/OpenAI style request -> Imagen `predict` body. */
export const convertToImagenRequest = (payload: Json): Json | undefined => {
  let prompt = "";
  const contentsText = get(payload, "contents.0.parts.0.text");

  if (contentsText !== undefined)
    prompt = typeof contentsText === "string" ? contentsText : JSON.stringify(contentsText);

  if (prompt === "") {
    const messages = get(payload, "messages");

    if (Array.isArray(messages)) {
      for (const message of messages) {
        const content = get(message, "content");

        const text =
          typeof content === "string"
            ? content
            : content === undefined
              ? ""
              : JSON.stringify(content);

        if (text !== "") {
          prompt = text;
          break;
        }
      }
    }
  }

  if (prompt === "") {
    const direct = get(payload, "prompt");

    if (direct !== undefined) prompt = typeof direct === "string" ? direct : JSON.stringify(direct);
  }

  if (prompt === "") return undefined;
  const instance: JsonObject = { prompt };
  const parameters: JsonObject = { sampleCount: 1 };
  const aspectRatio = get(payload, "aspectRatio");

  if (aspectRatio !== undefined)
    parameters["aspectRatio"] =
      typeof aspectRatio === "string" ? aspectRatio : JSON.stringify(aspectRatio);
  const sampleCount = get(payload, "sampleCount");

  if (sampleCount !== undefined) parameters["sampleCount"] = asInt(sampleCount);
  const negativePrompt = get(payload, "negativePrompt");

  if (negativePrompt !== undefined)
    instance["negativePrompt"] =
      typeof negativePrompt === "string" ? negativePrompt : JSON.stringify(negativePrompt);

  return { instances: [instance], parameters };
};

/** Go `convertImagenToGeminiResponse`: Imagen predictions -> a Gemini response the translators understand. */
export const convertImagenToGeminiResponse = (
  data: string,
  model: string,
  nowNanos: string,
): string => {
  const predictions = get(tryParseJson(data), "predictions");

  if (!Array.isArray(predictions)) return data;
  const parts: Json[] = [];

  for (const prediction of predictions) {
    const imageData = get(prediction, "bytesBase64Encoded");
    const mimeType = get(prediction, "mimeType");

    if (typeof imageData === "string" && imageData !== "") {
      parts.push({
        inlineData: {
          mimeType: typeof mimeType === "string" && mimeType !== "" ? mimeType : "image/png",
          data: imageData,
        },
      });
    }
  }

  return JSON.stringify({
    candidates: [{ content: { parts, role: "model" }, finishReason: "STOP" }],
    modelVersion: model,
    responseId: `imagen-${nowNanos}`,
    usageMetadata: { candidatesTokenCount: 0, promptTokenCount: 0, totalTokenCount: 0 },
  });
};

/**
 * Go `geminiPromptBlockErrorMessage` (3f5d3a16): a candidate-less response whose `promptFeedback.blockReason` is set
 * is an upstream refusal of the prompt, surfaced as a 502 instead of an empty 200.
 */
const promptBlockMessage = (root: Json | undefined): string | undefined => {
  if (root === undefined) return undefined;

  for (const node of [root, get(root, "response")]) {
    const candidates = get(node, "candidates");

    if (Array.isArray(candidates) && candidates.length > 0) return undefined;
  }

  for (const node of [root, get(root, "response")]) {
    const reason = get(node, "promptFeedback.blockReason");
    const trimmed = typeof reason === "string" ? reason.trim() : "";

    if (trimmed === "") continue;
    const detail = get(node, "promptFeedback.blockReasonMessage");
    const detailText = typeof detail === "string" ? detail.trim() : "";

    return detailText === ""
      ? `upstream blocked the prompt: ${trimmed}`
      : `upstream blocked the prompt: ${trimmed} - ${detailText}`;
  }

  return undefined;
};

export const makeGoogleExecutor = (variant: GoogleVariant): ProviderExecutor => {
  const registry = variant.translators ?? builtinTranslators;
  const to = Formats.Gemini;
  const continuations = variant.continuations ?? defaultContinuationStore;

  const send = Effect.fnUntraced(function* (context: ExecutionContext, prepared: PreparedRequest) {
    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.post(prepared.url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(prepared.body), "application/json"),
      HttpClientRequest.setHeaders(prepared.headers),
    );

    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(request)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      context.usage.fail(response.status, text);

      return yield* toExecutionError(response.status, text, new Headers(response.headers));
    }

    return response;
  });

  const headersFor = (attempt: Attempt, extra: Record<string, string> = {}) => {
    const headers = {
      "content-type": "application/json",
      ...attempt.target.authHeaders,
      ...extra,
    };

    applyCustomHeaders(
      headers,
      attempt.context.credential,
      attempt.options.headers,
      attempt.options.metadata.sessionId,
    );

    return headers;
  };

  const payloadRules = (
    attempt: Attempt,
    baseModel: string,
    protocol: string,
    original: Json | undefined,
    body: Json,
  ): Json => {
    const { options, request, context } = attempt;

    const requestedModel =
      options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

    // User payload rules: the final semantic mutation of the business payload (AGENTS.md).
    return applyPayloadRules(
      context.config,
      {
        model: baseModel,
        requestedModel,
        protocol,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: original ?? body,
      },
      body,
    ).payload;
  };

  /** Generate/stream/count preparation in the order of the Go executors. */
  const prepareGenerate = Effect.fnUntraced(function* (
    attempt: Attempt,
    mode: "generate" | "stream" | "count",
  ) {
    const { context, request, options, target } = attempt;
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const stream = mode === "stream";
    const imagen = variant.vertex && isImagenModel(baseModel);

    let body: Json;
    let original: Json | undefined;

    if (imagen) {
      const imagenBody = convertToImagenRequest(request.payload);

      if (imagenBody === undefined) {
        return yield* new ExecutionError({
          status: 400,
          message: "imagen: no prompt found in request",
          requestScoped: true,
        });
      }

      body = imagenBody;
      original = structuredClone(imagenBody);

      if (options.originalRequest !== undefined)
        original = convertToImagenRequest(options.originalRequest) ?? original;
    } else {
      if (from === Formats.OpenAIResponse) {
        // Cached text signatures of the assistant messages in the history, loaded in one round trip.
        const history = [options.originalRequest, request.payload].flatMap((payload) => {
          const input = get(payload, "input");

          return Array.isArray(input) ? textSignatureKeys(input) : [];
        });

        yield* attempt.replay.prefetch(baseModel, history);
      }

      const rewrite = {
        headers: options.headers,
        config: context.config,
        isCompat: modelIsCompat(request),
      };

      const translateWithReplay = (body: Json) =>
        translating(attempt, () =>
          translateRequestForExecutor(
            registry,
            from,
            to,
            { format: from, model: baseModel, stream, body },
            thinking.summary,
            rewrite,
          ),
        );

      original = translateWithReplay(options.originalRequest ?? request.payload).body;
      const translated = translateWithReplay(request.payload);

      if (translated.error !== undefined) return yield* requestError(translated);
      body = yield* thinking.apply({
        body: translated.body,
        model: request.model,
        from,
        to,
        provider: variant.identifier,
        source: request.payload,
        configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      });
      body = fixGeminiImageAspectRatio(baseModel, body);
      body = set(body, "model", baseModel);

      if (variant.vertex) body = stripVertexOpenAIResponsesToolCallIds(body, from);
      else body = capGeminiMaxOutputTokens(body, baseModel);

      if (mode === "count") {
        del(body, "tools");
        del(body, "generationConfig");
        del(body, "safetySettings");
      }

      sanitizeGeminiRequestThoughtSignatures(body, "contents");
    }

    if (mode === "stream") body = ensureGeminiBoundaryUserContent(body, "contents");
    else {
      body = ensureGeminiLeadingUserContent(body, "contents");

      if (mode === "generate") body = ensureGeminiTrailingUserContent(body, "contents");
    }

    del(body, "session_id");
    const effort = get(body, "generationConfig.thinkingConfig.thinkingLevel");
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);

    const action: GoogleAction =
      mode === "count"
        ? "countTokens"
        : imagen
          ? "predict"
          : stream
            ? "streamGenerateContent"
            : "generateContent";

    let url = target.url(action, baseModel);

    if (action !== "countTokens" && action !== "predict") {
      if (stream) url += options.alt === "" ? "?alt=sse" : `?$alt=${options.alt}`;
      else if (options.alt !== "") url += `?$alt=${options.alt}`;
    }

    const finalBody = payloadRules(attempt, baseModel, to, original, body);

    return {
      url,
      headers: headersFor(attempt),
      body: finalBody,
      baseModel,
      to,
      imagen,
      providerFormat: to,
    } satisfies PreparedRequest;
  });

  /** Native Interactions preparation (`executeInteractions*`). */
  const prepareInteractions = Effect.fnUntraced(function* (attempt: Attempt, stream: boolean) {
    const { context, request, options, target } = attempt;
    const thinking = yield* Thinking;
    const targetName = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const providerFormat = Formats.Interactions;

    const translate = (payload: Json): RequestEnvelope =>
      from === "" || from === Formats.Interactions
        ? { format: providerFormat, model: targetName, stream, body: structuredClone(payload) }
        : translateRequestForExecutor(
            registry,
            from,
            providerFormat,
            { format: from, model: targetName, stream, body: payload },
            thinking.summary,
            { headers: options.headers, config: context.config, isCompat: modelIsCompat(request) },
          );

    const working = translate(request.payload);

    if (working.error !== undefined) return yield* requestError(working);

    const original =
      options.originalRequest === undefined ? working : translate(options.originalRequest);

    let body = working.body;

    if (get(body, "model") !== undefined && targetName !== "")
      body = set(body, "model", targetName);
    body = yield* thinking.apply({
      body,
      model: request.model,
      from: from === "" ? providerFormat : from,
      to: providerFormat,
      provider: "gemini",
      source: request.payload,
    });
    body = sanitizeGeminiInteractionsUnsupportedInputIds(body);

    const continuation = yield* prepareAntigravityInteractions(
      continuations,
      attempt.context.credential,
      request,
      options,
      targetName,
      body,
    );

    body = continuation.body;

    if (stream) body = set(body, "stream", true);
    const finalBody = payloadRules(attempt, targetName, providerFormat, original.body, body);
    const headers = headersFor(attempt);
    applyInteractionsRevisionHeaders(headers, options.headers);

    return {
      url: target.interactionsUrl(stream),
      headers,
      body: finalBody,
      baseModel: targetName,
      to: providerFormat,
      imagen: false,
      providerFormat,
      continuation: continuation.state,
    } satisfies PreparedRequest;
  });

  const responseContext = (attempt: Attempt, prepared: PreparedRequest): ResponseContext => ({
    model: attempt.request.model,
    originalRequest: attempt.options.originalRequest ?? attempt.request.payload,
    translatedRequest: prepared.body,
    state: makeTranslationState(),
  });

  const resolve = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const target = yield* variant.resolveTarget(context, options);

    return {
      context,
      request,
      options,
      target,
      replay: makeRequestReplayCache(options.metadata.callerScope),
    } satisfies Attempt;
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.alt === "responses/compact")
      return yield* notImplemented("/responses/compact not supported");
    const attempt = yield* resolve(context, request, options);
    const native = variant.nativeInteractions(context, options);

    const prepared: PreparedRequest = native
      ? yield* prepareInteractions(attempt, false)
      : yield* prepareGenerate(attempt, "generate");

    const response = yield* send(context, prepared);
    let text = yield* response.text.pipe(Effect.mapError(transportError));

    if (prepared.imagen) {
      text = convertImagenToGeminiResponse(
        text,
        prepared.baseModel,
        `${yield* Clock.currentTimeMillis}000000`,
      );
    }

    const parsed = tryParseJson(text);
    context.usage.observeResponseModel(responseModelOf(parsed));

    if (prepared.continuation !== undefined) yield* prepared.continuation.observe(parsed);

    const blocked = native ? undefined : promptBlockMessage(parsed);

    if (blocked !== undefined) {
      context.usage.publish(parseGeminiUsageBody(parsed));
      context.usage.fail(502, blocked);

      return yield* new ExecutionError({ status: 502, message: blocked });
    }

    const out = translating(attempt, () =>
      registry.translateNonStream(
        responseFormatOf(options),
        prepared.providerFormat,
        responseContext(attempt, prepared),
        text,
      ),
    );

    yield* attempt.replay.flush;

    if (out === undefined || out === "") {
      return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
    }

    context.usage.publish(
      native ? parseInteractionsUsageBody(parsed) : parseGeminiUsageBody(parsed),
    );

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  /** Go `geminiStreamHasFinishSignal` (4f2e5270): a candidate `finishReason` or a prompt `blockReason`. */
  const hasFinishSignal = (payload: string): boolean => {
    const root = tryParseJson(payload);

    return [root, get(root, "response")].some((node) => {
      const candidates = get(node, "candidates");
      const block = get(node, "promptFeedback.blockReason");

      return (
        (Array.isArray(candidates) &&
          candidates.some((c) => {
            const reason = get(c, "finishReason");

            return typeof reason === "string" && reason.trim() !== "";
          })) ||
        (typeof block === "string" && block.trim() !== "")
      );
    });
  };

  /** Reads Gemini SSE lines: usage filter -> JSON payload -> translator, with a synthetic `[DONE]` at EOF. */
  const geminiStream = (
    attempt: Attempt,
    prepared: PreparedRequest,
    response: HttpClientResponse.HttpClientResponse,
  ): Stream.Stream<string, ExecutionError> => {
    const { context, options } = attempt;
    const responseFormat = responseFormatOf(options);
    const ctx = responseContext(attempt, prepared);

    // The text signatures a chunk produced are stored before the chunk reaches the client.
    const translate = (payload: string) =>
      Effect.sync(() =>
        translating(attempt, () =>
          registry.translateStream(responseFormat, prepared.providerFormat, ctx, payload),
        ),
      ).pipe(Effect.tap(() => attempt.replay.flush));

    const failToolInput = ctx.state;

    const check = (chunks: ReadonlyArray<string>) =>
      failToolInput.toolInputError !== undefined
        ? Stream.concat(
            Stream.fromIterable(chunks),
            Stream.fail(new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })),
          )
        : Stream.fromIterable(chunks);

    const translated = (payload: string) =>
      Stream.unwrap(translate(payload).pipe(Effect.map(check)));

    const lines = splitLines(response.stream).pipe(Stream.mapError(transportError));
    let sawFinish = false;

    return Stream.concat(
      lines.pipe(
        Stream.flatMap((line) => {
          context.usage.observeResponseModel(
            responseModelOf(tryParseJson(jsonPayload(line) ?? "")),
          );
          const usage = parseGeminiStreamUsage(line);

          if (usage !== undefined) context.usage.publish(usage);
          const filtered = variant.vertex ? line : filterSseUsageMetadata(line);
          const payload = jsonPayload(filtered);

          if (payload !== undefined && !sawFinish && hasFinishSignal(payload)) sawFinish = true;

          if (payload === undefined) return Stream.empty;
          const blocked = promptBlockMessage(tryParseJson(payload));

          if (blocked !== undefined)
            return Stream.fail(new ExecutionError({ status: 502, message: blocked }));

          return translated(payload);
        }),
      ),
      Stream.suspend(() =>
        // Claude and OpenAI chat clients fail a truncated stream (Go 4f2e5270, 3f5d3a16): they would otherwise see a
        // clean `message_stop` / `[DONE]`.
        (responseFormat === Formats.Claude || responseFormat === Formats.OpenAI) && !sawFinish
          ? Stream.fail(
              new ExecutionError({
                status: 502,
                message: "upstream stream closed before finishReason",
              }),
            )
          : translated("[DONE]"),
      ),
    );
  };

  /** Reads Interactions SSE frames (blank-line separated). */
  const interactionsStream = (
    attempt: Attempt,
    prepared: PreparedRequest,
    response: HttpClientResponse.HttpClientResponse,
  ): Stream.Stream<string, ExecutionError> => {
    const { context, options } = attempt;
    const responseFormat = responseFormatOf(options);
    const ctx = responseContext(attempt, prepared);

    const framePayload = (frame: string): string | undefined => {
      let payload = interactionsSsePayload(frame);

      if (payload === undefined && interactionsSseDone(frame)) payload = "[DONE]";

      if (payload === undefined && frame.trim().startsWith("{")) payload = frame.trim();

      return payload;
    };

    const emit = (frame: string): Stream.Stream<string, ExecutionError> => {
      const trimmed = frame.trim();

      if (trimmed === "") return Stream.empty;
      const payload = framePayload(frame);

      if (payload !== undefined) {
        context.usage.observeResponseModel(responseModelOf(tryParseJson(payload)));
        const usage = parseInteractionsStreamUsage(payload);

        if (usage !== undefined) context.usage.publish(usage);
      }

      if (responseFormat === Formats.Interactions)
        return Stream.succeed(`${frame.replace(/[\r\n]+$/, "")}\n\n`);

      if (payload === undefined) return Stream.empty;
      const chunks = registry.translateStream(responseFormat, Formats.Interactions, ctx, payload);

      return ctx.state.toolInputError !== undefined
        ? Stream.concat(
            Stream.fromIterable(chunks),
            Stream.fail(new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })),
          )
        : Stream.fromIterable(chunks);
    };

    const frames = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccum(
        (): ReadonlyArray<string> => [],
        (
          frame: ReadonlyArray<string>,
          line: string,
        ): readonly [ReadonlyArray<string>, ReadonlyArray<string>] =>
          line.trim() === "" ? [[], [frame.join("\n")]] : [[...frame, line], []],
        { onHalt: (frame: ReadonlyArray<string>) => [frame.join("\n")] },
      ),
    );

    // Antigravity continuation: completed `requires_action` interactions are remembered before their frames go out.
    const observed = (frame: string): Stream.Stream<string, ExecutionError> => {
      const payload = prepared.continuation === undefined ? undefined : framePayload(frame);

      const observe =
        prepared.continuation !== undefined && payload !== undefined && payload !== "[DONE]"
          ? prepared.continuation.observe(tryParseJson(payload))
          : Effect.void;

      return Stream.unwrap(observe.pipe(Effect.as(emit(frame))));
    };

    return frames.pipe(Stream.flatMap(observed));
  };

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.alt === "responses/compact")
      return yield* notImplemented("/responses/compact not supported");
    const attempt = yield* resolve(context, request, options);
    const native = variant.nativeInteractions(context, options);

    const prepared: PreparedRequest = native
      ? yield* prepareInteractions(attempt, true)
      : yield* prepareGenerate(attempt, "stream");

    const response = yield* send(context, prepared);

    const chunks = (
      native
        ? interactionsStream(attempt, prepared, response)
        : prepared.imagen
          ? imagenStream(attempt, prepared, response)
          : geminiStream(attempt, prepared, response)
    ).pipe(
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  /** Imagen has no streaming: the single response is converted and translated as one chunk. */
  const imagenStream = (
    attempt: Attempt,
    prepared: PreparedRequest,
    response: HttpClientResponse.HttpClientResponse,
  ): Stream.Stream<string, ExecutionError> =>
    Stream.fromEffect(response.text.pipe(Effect.mapError(transportError))).pipe(
      Stream.flatMap((text) => {
        const data = convertImagenToGeminiResponse(text, prepared.baseModel, `${Date.now()}000000`);
        const ctx = responseContext(attempt, prepared);
        const responseFormat = responseFormatOf(attempt.options);
        const payload = jsonPayload(data) ?? data;

        return Stream.fromIterable(
          withModelInfoLookup(attempt.request.modelLookup, () => [
            ...registry.translateStream(responseFormat, prepared.providerFormat, ctx, payload),
            ...registry.translateStream(responseFormat, prepared.providerFormat, ctx, "[DONE]"),
          ]),
        );
      }),
    );

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolve(context, request, options);
    const prepared = yield* prepareGenerate(attempt, "count");
    const response = yield* send(context, prepared);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const count = asInt(get(tryParseJson(text), "totalTokens"));

    const payload = registry.translateTokenCount(
      responseFormatOf(options),
      prepared.providerFormat,
      count,
      text,
    );

    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  return { identifier: variant.identifier, execute, executeStream, countTokens };
};

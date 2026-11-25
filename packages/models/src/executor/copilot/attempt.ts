/**
 * One Copilot attempt and the steps every route shares: the route and trusted credential (`prepare`'s checks), the
 * translation with the CLI defaults and the thinking pipeline, the payload rules, the send to the trusted origin, the
 * response context and the reading of the upstream answer.
 *
 * Go source: internal/runtime/executor/copilot_executor.go (`prepare`, `send`), helps/copilot.go
 * (`ApplyCopilotThinking`), copilot_executor_response.go (20211183: the stream hint).
 */
import { Clock, Effect, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext, TranslatorRegistry } from "@commissary/translation";
import { EntryOnlyFormats, Formats } from "@commissary/translation/formats";
import { splitLines } from "@commissary/translation/sse";
import { parseSuffix } from "@commissary/translation/thinking";
import { isTrustedCopilotApi } from "../../oauth/flows/copilot.ts";
import { responseModelOf } from "../../usage/record.ts";
import { ExecutionError, headersRecord, notImplemented } from "../errors.ts";
import { finalizePayload } from "../helps/payload.ts";
import { translatorResponseContext } from "../helps/responses-sse.ts";
import { openAICompatRetryAfterMs } from "../helps/retry-after.ts";
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { transportError } from "../helps/transport-error.ts";
import { Thinking } from "../thinking.ts";
import type { StreamStep } from "../openai-compat/stream.ts";
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  responseFormatOf,
  type StreamResult,
} from "../types.ts";
import {
  copilotDefaultSummary,
  copilotHeaders,
  copilotResponseError,
  copilotTurnIds,
  type CopilotTurnIds,
  dropSynthesizedUserId,
  parseCopilotTurnInput,
  seedCopilotDefaults,
  type SeedInput,
} from "./request.ts";
import {
  COPILOT_PROVIDER,
  copilotNativeModel,
  type CopilotRoute,
  resolveCopilotRoute,
} from "./routes.ts";

const UNSUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  EntryOnlyFormats.OpenAIImage,
  EntryOnlyFormats.OpenAIVideo,
  EntryOnlyFormats.OpenAISpeech,
  EntryOnlyFormats.CodexAlphaSearch,
  EntryOnlyFormats.SystemOne,
]);

/** Everything one attempt needs: the route, the trusted origin and token, and the turn identity. */
export interface CopilotAttempt {
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

export const str = (value: Json | undefined): string =>
  typeof value === "string" ? value.trim() : "";

export const requestError = (status: number, message: string) =>
  new ExecutionError({ status, message, requestScoped: true });

/** `prepare`'s checks and `resolveRoute`: the route, the trusted credential and the turn identity of an attempt. */
export const resolveAttempt = (
  registry: TranslatorRegistry,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
): Effect.Effect<CopilotAttempt, ExecutionError> =>
  Effect.gen(function* () {
    const from = options.sourceFormat;

    if (UNSUPPORTED_FORMATS.has(from))
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
export const asObject = (body: Json): Effect.Effect<JsonObject, ExecutionError> =>
  isJsonObject(body)
    ? Effect.succeed(body)
    : Effect.fail(requestError(400, "copilot: invalid request payload"));

/** The CLI-profile defaults of an attempt (`seedCopilotDefaults`), before the thinking pipeline validates them. */
export const seedDefaults = (
  attempt: CopilotAttempt,
  body: JsonObject,
  upstreamStream: boolean,
): void => {
  const input: SeedInput = {
    route: attempt.route,
    source: attempt.request.payload,
    from: attempt.options.sourceFormat,
    suffixed: parseSuffix(attempt.request.model).hasSuffix,
    upstreamStream,
  };

  seedCopilotDefaults(body, input);
};

/**
 * Translation to the route's protocol, the CLI defaults and the thinking pipeline (Chat Completions and Messages):
 * the body before the protocol fixes, and the original request translated the same way (payload-rule context).
 */
export const translateForCopilot = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  stream: boolean,
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
  seedDefaults(attempt, body, stream);

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
    defaultSummary: copilotDefaultSummary(route),
  });

  return { body: yield* asObject(applied), original };
});

/** User payload rules: the final semantic mutation of the business payload (AGENTS.md). */
export const finalizeForCopilot = (attempt: CopilotAttempt, original: Json, body: Json): Json =>
  finalizePayload(
    attempt.context.config,
    COPILOT_PROVIDER,
    {
      model: attempt.route.model,
      requestedModel:
        attempt.options.metadata.requestedModel !== ""
          ? attempt.options.metadata.requestedModel
          : attempt.request.model,
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
export const checkStreamMode = (body: Json, stream: boolean): Effect.Effect<void, ExecutionError> =>
  (get(body, "stream") === true) === stream
    ? Effect.void
    : Effect.fail(
        requestError(
          400,
          "copilot: payload stream mode does not match the requested response mode",
        ),
      );

/** Posts the body to the credential's trusted origin; non-2xx answers become `ExecutionError`s. */
export const send = Effect.fnUntraced(function* (attempt: CopilotAttempt, body: Json) {
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
export const responseContext = (
  attempt: CopilotAttempt,
  translated: Json,
  stream: boolean,
): ResponseContext => {
  const context = translatorResponseContext(attempt.request, attempt.options, translated);
  const original = context.originalRequest;

  const streamHinted =
    stream &&
    attempt.route.format === Formats.OpenAI &&
    responseFormatOf(attempt.options) === Formats.Claude &&
    get(original, "stream") !== true &&
    isJsonObject(original);

  return streamHinted ? { ...context, originalRequest: { ...original, stream: true } } : context;
};

export const failed = (attempt: CopilotAttempt, error: ExecutionError) => {
  attempt.context.usage.fail(error.status, error.message);

  return Effect.fail(error);
};

/**
 * A non-stream JSON answer: invalid JSON and Copilot's error bodies (`copilotResponseError`) fail the attempt; the
 * answering model is recorded.
 */
export const readUpstreamJson = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  text: string,
) {
  const parsed = tryParseJson(text);

  if (parsed === undefined)
    return yield* failed(
      attempt,
      new ExecutionError({ status: 502, message: "copilot: invalid upstream JSON response" }),
    );
  const upstreamError = copilotResponseError(text);

  if (upstreamError !== undefined) return yield* failed(attempt, upstreamError);
  attempt.context.usage.observeResponseModel(responseModelOf(parsed));

  return parsed;
});

/** Each upstream SSE line, with invalid data and Copilot's error frames failing the stream (`copilotResponseError`). */
const upstreamLines = (response: {
  readonly stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
}) =>
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

/** A stream reader of the Chat Completions or Messages events (`OpenAICompatStreamReader`, `ClaudeStreamReader`). */
interface LineReader {
  push(line: string): StreamStep;
  end(): StreamStep;
}

/**
 * The client's chunks of a streamed answer: each upstream line through `reader` until it stops; a failure ends the
 * stream after the chunks it emitted, and is recorded on the usage.
 */
export const readerStream = (
  attempt: CopilotAttempt,
  response: HttpClientResponse.HttpClientResponse,
  reader: LineReader,
): StreamResult => {
  const { usage } = attempt.context;

  const chunks = upstreamLines(response).pipe(
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
      usage.fail(
        error.status,
        step.payloadError === true ? "upstream stream returned an error payload" : error.message,
      );

      return Stream.concat(emitted, Stream.fail(error));
    }),
    Stream.tapError((error) => Effect.sync(() => usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks };
};

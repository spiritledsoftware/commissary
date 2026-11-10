/**
 * Meta (Muse, `api.meta.ai`) executor: OpenAI Responses over SSE.
 *
 * Go source: internal/runtime/executor/meta_executor.go, meta_executor_execute.go (Execute, `translateMetaCompleted`,
 * `applyMetaAPIHeaders`, `wrapMetaUpstreamError`, `metaAsCompletedEvent`), meta_executor_stream.go (ExecuteStream).
 * The upstream always streams (non-stream callers get the aggregated terminal event). The lazy DCA -> provider-key mint
 * is done by the conductor through `ControlPlane.ensureFresh` before the attempt (`withCredentialRefresh`).
 *
 * `CountTokens` counts the prepared body locally with `o200k_base`. The apply_patch Responses bridge wraps the event
 * flow (`helps/apply-patch-responses.ts`). `response.subscription_usage` telemetry is dropped from streams and
 * aggregated answers (`subscription-usage.ts`); the Muse namespace is appended to tool-bearing requests
 * (`muse-tools.ts`); the 1.4.14 client identity headers are in `identity.ts`. The request shaping and the SSE response
 * handling are shared with the OpenCode executor (`helps/responses-request.ts`, `helps/responses-sse.ts`). Not ported:
 * outbound proxies.
 */
import { Clock, Effect } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { asString, get } from "@commissary/json";
import { builtinTranslators, type TranslatorRegistry } from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { ExecutionError } from "../errors.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import {
  collectResponsesSse,
  type ResponsesSseInput,
  streamResponsesSse,
} from "../helps/responses-sse.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  ProviderExecutor,
} from "../types.ts";
import { requireMetaToken } from "./credentials.ts";
import { metaIdentityHeaders } from "./identity.ts";
import { makeSubscriptionUsageFilter } from "./subscription-usage.ts";
import { metaStreamEventError, wrapMetaUpstreamError } from "./errors.ts";
import { buildResponsesUsageJson, countCodexInputTokens } from "../helps/token-count.ts";
import { getCodec } from "@commissary/translation/tokenizer";
import { type MetaPrepared, prepareMetaRequest } from "./request.ts";

export const META_PROVIDER = "meta";

const STREAM_STALL =
  "meta stream error: stream disconnected before response.completed or response.incomplete";

export interface MetaExecutorOptions {
  readonly translators?: TranslatorRegistry;
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

export interface MetaHeadersInput {
  readonly credential: CredentialSnapshot;
  readonly token: string;
  readonly stream: boolean;
  readonly clientHeaders: Headers;
  readonly sessionId: string | undefined;
  /** The effective model after the payload rules (decides the contributor header). */
  readonly model: string;
  readonly nowMs: number;
}

/** `applyMetaAPIHeaders`: content type, bearer token, the Muse client identity, then custom/client headers. */
export const metaHeaders = (input: MetaHeadersInput): Record<string, string> => {
  const { credential, token, stream, clientHeaders, sessionId, model, nowMs } = input;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...metaIdentityHeaders(model, nowMs),
    accept: stream ? "text/event-stream" : "application/json",
  };

  return applyCustomHeaders(
    stream ? { ...headers, "cache-control": "no-cache" } : headers,
    credential,
    clientHeaders,
    sessionId,
  );
};

export const makeMetaExecutor = (executorOptions: MetaExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  const unsupported = (options: ExecutorOptions) =>
    options.alt === "responses/compact"
      ? Effect.fail(
          new ExecutionError({
            status: 501,
            message: "/responses/compact not supported",
            requestScoped: true,
          }),
        )
      : Effect.void;

  /** Prepares the body and sends it; non-2xx answers are wrapped with the Meta cooldown rules. */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    /** Streams take the effective TTFT from the first token event; non-stream answers from the first byte. */
    ttft: "first-byte" | "token-event",
  ) {
    yield* unsupported(options);

    const creds = yield* Effect.try({
      try: () => requireMetaToken(context.credential),
      catch: (error) =>
        error instanceof ExecutionError
          ? error
          : new ExecutionError({ status: 500, message: String(error) }),
    });

    const prepared = yield* prepareMetaRequest(registry, context, request, options, META_PROVIDER);
    const effort = asString(get(prepared.body, "reasoning.effort"));
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
    const client = yield* HttpClient.HttpClient;
    const url = `${creds.baseUrl.replace(/\/+$/, "")}/responses`;

    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(prepared.body), "application/json"),
      HttpClientRequest.setHeaders(
        metaHeaders({
          credential: context.credential,
          token: creds.token,
          stream: true,
          clientHeaders: options.headers,
          sessionId: options.metadata.sessionId,
          model: prepared.effectiveModel,
          nowMs: yield* Clock.currentTimeMillis,
        }),
      ),
    );

    const response = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    if (ttft === "token-event") context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);
    else context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      context.usage.fail(response.status, text);

      return yield* wrapMetaUpstreamError(response.status, text, yield* Clock.currentTimeMillis);
    }

    return { response, prepared };
  });

  const sse = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    sent: {
      readonly response: HttpClientResponse.HttpClientResponse;
      readonly prepared: MetaPrepared;
    },
  ): ResponsesSseInput => ({
    registry,
    context,
    request,
    options,
    prepared: sent.prepared,
    response: sent.response,
    eventError: metaStreamEventError,
    stallMessage: STREAM_STALL,
    lineFilter: makeSubscriptionUsageFilter,
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const sent = yield* send(context, request, options, "first-byte");

    return yield* collectResponsesSse(sse(context, request, options, sent));
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const sent = yield* send(context, request, options, "token-event");

    return streamResponsesSse(sse(context, request, options, sent));
  });

  /** `CountTokens`: the Responses body that would be sent upstream, counted locally with `o200k_base`. */
  const countTokens: ProviderExecutor["countTokens"] = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    yield* Effect.try({
      try: () => requireMetaToken(context.credential),
      catch: (error) =>
        error instanceof ExecutionError
          ? error
          : new ExecutionError({ status: 500, message: String(error) }),
    });

    const prepared = yield* prepareMetaRequest(
      registry,
      context,
      request,
      options,
      META_PROVIDER,
      false,
    );

    const count = countCodexInputTokens(getCodec("o200k_base"), prepared.body);

    return {
      payload: registry.translateTokenCount(
        prepared.responseFormat,
        Formats.Codex,
        count,
        buildResponsesUsageJson(count),
      ),
      headers: new Headers(),
    } satisfies ExecutorResponse;
  });

  return { identifier: META_PROVIDER, execute, executeStream, countTokens };
};

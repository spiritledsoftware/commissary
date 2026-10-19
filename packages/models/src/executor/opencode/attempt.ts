/**
 * One OpenCode Zen/Go attempt: the resolved protocol, endpoint and key, the request shaping shared by the chat and
 * Messages paths, and the HTTP exchange.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"). The shaping order follows the other provider-key executors (openai_compat_executor.go, claude_executor.go):
 * translate -> thinking -> protocol fields -> payload rules (final mutation).
 */
import { Clock, Effect } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { cloneJson, type Json } from "@commissary/json";
import {
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { ExecutionError } from "../errors.ts";
import { finalizePayload } from "../helps/payload.ts";
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { Thinking } from "../thinking.ts";
import type { ExecutionContext, ExecutorOptions, ExecutorRequest } from "../types.ts";
import { isCloakedRequest, resolveOpenCodeCloakMode } from "./cloak.ts";
import { FREE_ENDPOINTS_HINT, openCodeModelFault, openCodeUpstreamError } from "./errors.ts";
import type { ResolvedProtocol } from "./protocol.ts";
import { OPENCODE_SPECS, type OpenCodeProvider } from "./providers.ts";

/** Everything the request shaping needs (token counting has no endpoint). */
export interface OpenCodeShaping {
  readonly provider: OpenCodeProvider;
  readonly registry: TranslatorRegistry;
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly resolved: ResolvedProtocol;
  /** Model without the thinking suffix. */
  readonly baseModel: string;
  /** Whether the attempt carries the OpenCode Zen free-tier cloak (`cloak.ts`, ADR 0033). */
  readonly cloaked: boolean;
}

export interface OpenCodeAttempt extends OpenCodeShaping {
  /** Gateway base URL without a trailing slash. */
  readonly baseUrl: string;
  readonly providerKey: string;
}

/** The credential's endpoint (`base_url`, else the gateway default) and key; a key is required. */
export const openCodeEndpoint = (
  context: ExecutionContext,
  provider: OpenCodeProvider,
): Effect.Effect<{ readonly baseUrl: string; readonly providerKey: string }, ExecutionError> => {
  const providerKey = (context.credential.attributes["api_key"] ?? "").trim();
  const configured = (context.credential.attributes["base_url"] ?? "").trim();

  const baseUrl = (configured === "" ? OPENCODE_SPECS[provider].baseUrl : configured).replace(
    /\/+$/,
    "",
  );

  return providerKey === ""
    ? Effect.fail(
        new ExecutionError({
          status: 401,
          message: `${OPENCODE_SPECS[provider].displayName} credential has no api key`,
        }),
      )
    : Effect.succeed({ baseUrl, providerKey });
};

export const makeShaping = (
  input: Omit<OpenCodeShaping, "baseModel" | "cloaked">,
): OpenCodeShaping => ({
  ...input,
  baseModel: parseSuffix(input.request.model).modelName,
  cloaked: isCloakedRequest(
    resolveOpenCodeCloakMode(input.context.config, input.context.credential, input.provider),
    input.resolved.protocol,
    input.resolved.catalogModel,
  ),
});

/** The model the client asked for (payload rules). */
export const requestedModelOf = (shaping: OpenCodeShaping): string =>
  shaping.options.metadata.requestedModel !== ""
    ? shaping.options.metadata.requestedModel
    : shaping.request.model;

export interface TranslatedRequest {
  /** Body after translation and thinking. */
  readonly body: Json;
  /** The original client request translated the same way (payload-rule context). */
  readonly original: Json;
}

/** Translation to the upstream format and thinking (`to`: `openai` or `claude`). */
export const translateForOpenCode = Effect.fnUntraced(function* (
  shaping: OpenCodeShaping,
  to: string,
  stream: boolean,
) {
  const { registry, context, request, options } = shaping;
  const thinking = yield* Thinking;
  const from = options.sourceFormat;

  const translate = (payload: Json) =>
    translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: shaping.baseModel, stream, body: payload },
      thinking.summary,
      { headers: options.headers, config: context.config, isCompat: modelIsCompat(request) },
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

  const body = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider: shaping.provider,
    source: request.payload,
    ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup,
  });

  return { body, original } satisfies TranslatedRequest;
});

/** User payload rules: the final semantic mutation of the business payload (AGENTS.md). */
export const finalizeForOpenCode = (
  shaping: OpenCodeShaping,
  protocol: string,
  original: Json,
  body: Json,
): Json =>
  finalizePayload(
    shaping.context.config,
    shaping.provider,
    {
      model: shaping.baseModel,
      requestedModel: requestedModelOf(shaping),
      protocol,
      fromProtocol: shaping.options.sourceFormat,
      requestPath: shaping.options.metadata.requestPath,
      headers: shaping.options.headers,
      original,
    },
    body,
  );

/** Translator response context of an attempt. */
export const openCodeResponseContext = (
  shaping: OpenCodeShaping,
  translated: Json,
): ResponseContext => ({
  model: shaping.request.model,
  originalRequest: shaping.options.originalRequest ?? shaping.request.payload,
  translatedRequest: translated,
  state: makeTranslationState(),
});

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
export const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

/** POSTs a JSON body; non-2xx answers become classified `ExecutionError`s carrying the upstream body. */
export const postJson = Effect.fnUntraced(function* (
  attempt: OpenCodeAttempt,
  url: string,
  headers: Record<string, string>,
  body: Json,
): Effect.fn.Return<HttpClientResponse.HttpClientResponse, ExecutionError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;

  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
    HttpClientRequest.setHeaders(headers),
  );

  const response = yield* client
    .execute(request)
    .pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(transportError),
    );

  const { usage } = attempt.context;
  usage.markFirstByte(yield* Clock.currentTimeMillis);

  if (response.status >= 200 && response.status < 300) return response;
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  usage.fail(response.status, text);

  if (openCodeModelFault(response.status, text) === "free-endpoints")
    yield* Effect.logWarning(FREE_ENDPOINTS_HINT);

  return yield* openCodeUpstreamError({
    provider: attempt.provider,
    status: response.status,
    body: text,
    headers: new Headers(response.headers),
    nowMs: yield* Clock.currentTimeMillis,
  });
});

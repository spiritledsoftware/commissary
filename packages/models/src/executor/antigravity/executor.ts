/**
 * Antigravity (Cloud Code `v1internal`) executor.
 *
 * Go source: internal/runtime/executor/antigravity_executor.go (+ `_execute`, `_stream`, `_request`, `_tokens`,
 * `_credits`). Canonical order per attempt (ARCHITECTURE.md): signature validation -> translate -> thinking ->
 * sensitive words -> signature sanitising -> credits -> boundary turns -> envelope (`geminiToAntigravity`) -> model
 * shaping -> payload rules (always last) -> `fetch`. Token refresh, the 401 repeat and `project_id` preparation run in
 * the conductor (`withCredentialRefresh`); retry rounds across credentials are the conductor's, so exactly one
 * upstream request is made per attempt.
 *
 * Compaction (`responses/compact`, `compaction_trigger`) runs a non-stream summary turn and seals it into a
 * capsule (`helps/compaction.ts`); web-search grounding redirect URLs are resolved (`grounding.ts`).
 *
 * Deviations from Go (see ARCHITECTURE.md "Antigravity provider"): no per-credential HTTP pools or proxies, and the short quota cooldown / credits state live in KV `CACHE`.
 */
import { derivedAntigravitySessionId } from "./derived-session.ts";
import { translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Option, Result, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { buildSensitiveWordMatcher } from "../claude/cloaking.ts";
import type { Config } from "../../config/schema.ts";
import {
  asInt,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
  tryParseJson,
} from "@commissary/json";
import { splitLines } from "@commissary/translation/sse";
import { fetchProjectId } from "../../oauth/flows/antigravity.ts";
import {
  type DeploymentKv,
  type OrgId,
  type OrgKv,
  WorkerExecutionContext,
} from "@commissary/core";
import { controlPlaneOf, optionalRequestOrg } from "@commissary/state";
import {
  isolateSignatureCache,
  type MemorySignatureCache,
  withSignatureContext,
  flushSignatureWrites,
  prefetchSignatures,
} from "@commissary/translation/signature";
import { makeKvSignatureStore } from "../../signature/store.ts";
import {
  thinkingTextsNeedingCachedSignatures,
  builtinTranslators,
  withModelInfoLookup,
  makeTranslationState,
  type RequestEnvelope,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { isGeminiTokenEvent } from "../../usage/ttft.ts";
import { parseAntigravityStreamUsage, parseAntigravityUsage } from "../../usage/parsers.ts";
import { responseModelOf } from "../../usage/record.ts";
import { ExecutionError } from "../errors.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
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
import {
  ensureBoundaryUserContent,
  ensureLeadingUserContent,
  sanitizeGeminiRequestSignatures,
  validateRequestSignatures,
} from "./content.ts";
import {
  buildCompactionResponse,
  buildCompactionStreamChunks,
  expandCompactionCapsules,
  extractSummaryText,
  hasResponsesCompactionItem,
  hasResponsesCompactionTrigger,
  prepareCompactionSummaryPayload,
  responsesSummaryUsage,
  sealCompaction,
} from "../helps/compaction.ts";
import { resolveGroundingUrlsInPayload, shouldResolveGroundingUrls } from "./grounding.ts";
import { creditsEnabled, injectEnabledCreditTypes, probeCredits } from "./credits.ts";
import { NO_REPLAY_SCOPE, type ReplayAccumulator, type ReplayScope } from "./replay/accumulator.ts";
import { defaultReplayLedger, type ReplayLedger } from "./replay/ledger.ts";
import {
  clearReplayOnInvalidSignature,
  makeAccumulator,
  prepareReplayPayload,
} from "./replay/prepare.ts";
import {
  ANTIGRAVITY_COUNT_TOKENS_PATH,
  ANTIGRAVITY_GENERATE_PATH,
  ANTIGRAVITY_STREAM_PATH,
  configuredUserAgent,
  geminiToAntigravity,
  requestBaseUrl,
  constrainRequestPayload,
} from "./envelope.ts";
import {
  antigravityStatusError,
  decideAntigravity429,
  hasExplicitCreditsBalanceExhaustedReason,
} from "./errors.ts";
import { type AntigravityState, antigravityStateFor } from "./state.ts";
import { convertStreamToNonStream, JsonAssembler, UsageFilter } from "./stream.ts";
import { antigravityRequestUserAgent, currentAntigravityVersion } from "./version.ts";
import { ModelsEnv } from "../../env.ts";
import { deploymentKvIfBound, orgKvIfBound } from "../../kv.ts";

export const ANTIGRAVITY_IDENTIFIER = "antigravity";

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

const requestError = (envelope: RequestEnvelope) =>
  new ExecutionError({
    status: envelope.error?.status ?? 400,
    message: envelope.error?.message ?? "invalid request",
    requestScoped: true,
  });

/** `antigravityCoolingDisabled`. */
const coolingDisabled = (context: ExecutionContext): boolean => {
  const flag = context.credential.metadata["disable_cooling"];

  return (
    flag === true ||
    (typeof flag === "string" && flag.toLowerCase() === "true") ||
    context.config.routing.cooldown["disable-cooling"]
  );
};

/** Models served through a streaming upstream request and aggregated for non-stream callers. */
export const aggregatesStream = (baseModel: string): boolean =>
  baseModel.toLowerCase().includes("claude") ||
  baseModel.includes("gemini-3-pro") ||
  baseModel.includes("gemini-3.1-flash-image");

interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Json;
  readonly baseModel: string;
  /** Translated (pre-envelope) request handed to the response translators. */
  readonly translated: Json;
  readonly useCredits: boolean;
  /** Reasoning replay of Gemini models: the scope (with the ledger snapshot read) and the response accumulator. */
  readonly replayScope: ReplayScope;
  readonly replay: ReplayAccumulator | undefined;
}

interface Attempt {
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly state: AntigravityState;
  /** The org's KV entries (signatures); `undefined` without a `CACHE` binding. */
  readonly kv: OrgKv | undefined;
  /** The deployment-wide KV entries (the client version). */
  readonly deploymentKv: DeploymentKv | undefined;
  readonly signatures: MemorySignatureCache;
  /** The request's org: the state, signatures and credential belong to it. */
  readonly org: OrgId;
  readonly waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  readonly accessToken: string;
  /** `project_id` of the credential (discovered through `loadCodeAssist` when the stored one is missing). */
  readonly project: string;
}

export interface AntigravityExecutorOptions {
  readonly translators?: TranslatorRegistry;
  /** Gemini reasoning replay ledger (defaults to the `SessionState` Durable Object, per-isolate memory without it). */
  readonly replayLedger?: ReplayLedger;
}

export const makeAntigravityExecutor = (
  settings: AntigravityExecutorOptions = {},
): ProviderExecutor => {
  const registry = settings.translators ?? builtinTranslators;
  const to = Formats.Antigravity;
  const ledger = settings.replayLedger ?? defaultReplayLedger;

  const resolve = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const env = Option.getOrUndefined(yield* Effect.serviceOption(ModelsEnv));
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(WorkerExecutionContext));
    // Like `ModelsEnv`, optional so the executor runs outside a request (unit tests); a request must carry it.
    const org = yield* optionalRequestOrg;

    const accessToken =
      typeof context.credential.metadata["access_token"] === "string"
        ? context.credential.metadata["access_token"].trim()
        : "";

    if (accessToken === "") {
      return yield* new ExecutionError({
        status: 401,
        message: "missing access token",
        credentialScoped: true,
      });
    }

    // `PrepareRequestAuth`: a credential without `project_id` (discovery failed at login) is completed here.
    let project =
      typeof context.credential.metadata["project_id"] === "string"
        ? context.credential.metadata["project_id"].trim()
        : "";

    if (project === "") {
      const discovered = yield* fetchProjectId(accessToken).pipe(Effect.result);

      if (Result.isFailure(discovered) || discovered.success.trim() === "") {
        const cause = Result.isFailure(discovered) ? `: ${discovered.failure.message}` : "";

        return yield* new ExecutionError({
          status: 400,
          message: `antigravity auth missing project_id${cause}`,
          requestScoped: true,
        });
      }

      project = discovered.success.trim();

      if (env !== undefined) {
        yield* Effect.tryPromise(
          async () =>
            await controlPlaneOf(env, org).models().patchCredentialMetadata(context.credential.id, {
              project_id: project,
            }),
        ).pipe(Effect.ignore);
      }
    }

    return {
      context,
      request,
      options,
      project,
      org,
      state: antigravityStateFor(env, org),
      kv: orgKvIfBound(env, org),
      deploymentKv: deploymentKvIfBound(env),
      signatures: isolateSignatureCache(org),
      waitUntil:
        typeof ctx?.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : undefined,
      accessToken,
    } satisfies Attempt;
  });

  const signatureSettings = (config: Config) => ({
    cacheEnabled: config.oauth.providers.antigravity["signature-cache-enabled"] ?? true,
    bypassStrictMode: config.oauth.providers.antigravity["signature-bypass-strict"] ?? false,
  });

  /** Runs one synchronous translator call with the attempt's signature cache, settings and model lookup. */
  const translating = <T>(attempt: Attempt, run: () => T): T =>
    withSignatureContext(
      { cache: attempt.signatures, settings: signatureSettings(attempt.context.config) },
      () => withModelInfoLookup(attempt.request.modelLookup, run),
    );

  const persistSignatures = (attempt: Attempt): Effect.Effect<void> => {
    const store = attempt.kv === undefined ? undefined : makeKvSignatureStore(attempt.kv);

    if (store === undefined) return Effect.void;
    const flush = flushSignatureWrites(attempt.signatures, store);

    if (attempt.waitUntil !== undefined) {
      attempt.waitUntil(flush);

      return Effect.void;
    }

    return Effect.promise(() => flush);
  };

  const userAgent = (attempt: Attempt) =>
    Effect.gen(function* () {
      const version = yield* currentAntigravityVersion(
        attempt.deploymentKv,
        yield* Clock.currentTimeMillis,
      );

      const credential = attempt.context.credential;

      return antigravityRequestUserAgent(
        configuredUserAgent(credential.attributes, credential.metadata),
        version,
      );
    });

  const headersFor = (attempt: Attempt, agent: string) => {
    // Whitelist: only the headers the native client sends (plus the credential's own `header:*` attributes).
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${attempt.accessToken}`,
      "user-agent": agent,
    };

    applyCustomHeaders(
      headers,
      attempt.context.credential,
      attempt.options.headers,
      attempt.options.metadata.sessionId,
    );

    return headers;
  };

  /** Short quota cooldown (`antigravityIsInShortCooldownRequired`): answers 429 so the conductor switches auth. */
  const checkShortCooldown = (attempt: Attempt, baseModel: string) =>
    Effect.gen(function* () {
      const { context, options, state } = attempt;

      if (coolingDisabled(context)) return;
      const bypass = options.metadata.antigravityCredits === true && creditsEnabled(context.config);

      if (bypass) return;
      const now = yield* Clock.currentTimeMillis;

      const remaining = yield* Effect.promise(() =>
        state.shortCooldownRemaining(context.credential.id, baseModel, now),
      );

      if (remaining > 0) {
        return yield* new ExecutionError({
          status: 429,
          message: `auth in short cooldown, ${Math.ceil(remaining / 1000)}s remaining`,
          retryAfterMs: remaining,
        });
      }
    });

  /** `maybeRefreshAntigravityCreditsHint`: best-effort balance probe in the background. */
  const maybeRefreshCredits = (
    attempt: Attempt,
    agent: string,
  ): Effect.Effect<void, never, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const { context, state } = attempt;

      if (!creditsEnabled(context.config) || coolingDisabled(context)) return;
      const now = yield* Clock.currentTimeMillis;

      if ((yield* Effect.promise(() => state.credits(context.credential.id))) !== undefined) return;

      if (!(yield* Effect.promise(() => state.claimCreditsRefresh(context.credential.id, now))))
        return;
      const client = yield* HttpClient.HttpClient;

      const probe = probeCredits(context.credential, attempt.accessToken, agent, state, now).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      if (attempt.waitUntil !== undefined) attempt.waitUntil(Effect.runPromise(probe));
    });

  /** Request preparation shared by generate, stream and aggregate modes (`Execute`/`ExecuteStream`). */
  const prepare = Effect.fnUntraced(function* (
    attempt: Attempt,
    mode: "generate" | "stream" | "aggregate",
    agent: string,
  ) {
    const { context, request, options } = attempt;
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const stream = mode === "stream";
    const upstreamStream = mode !== "generate";
    // Claude-format clients carry thinking blocks whose signatures are validated against the upstream's rules.
    const source = structuredClone(options.originalRequest ?? request.payload);
    const original = validateRequestSignatures(baseModel, from, source);

    const texts =
      from === Formats.Claude
        ? translating(attempt, () => thinkingTextsNeedingCachedSignatures(baseModel, original))
        : [];

    const { kv } = attempt;

    if (texts.length > 0 && kv !== undefined) {
      yield* Effect.promise(() =>
        prefetchSignatures(attempt.signatures, makeKvSignatureStore(kv), baseModel, texts),
      );
    }

    const translateWith = (body: Json, streamFlag: boolean) =>
      translating(attempt, () =>
        translateRequestForExecutor(
          registry,
          from,
          to,
          {
            format: from,
            model: baseModel,
            stream: streamFlag,
            body: structuredClone(body),
            ...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
          },
          thinking.summary,
          { headers: options.headers, config: context.config },
        ),
      );

    const translated = translateWith(original, upstreamStream);

    if (translated.error !== undefined) return yield* requestError(translated);
    // Baseline of the payload rules: the translation before thinking and shaping.
    const originalTranslatedBody = structuredClone(translated.body);

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider: ANTIGRAVITY_IDENTIFIER,
      source: original,
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    const words = context.config.oauth.providers.antigravity["sensitive-words"];
    body = obfuscateSystemInstruction(body, words);
    body = sanitizeGeminiRequestSignatures(baseModel, body);

    if (stream) del(body, "request.stream");
    const effort = get(body, "request.generationConfig.thinkingConfig.thinkingLevel");
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);

    const useCredits =
      options.metadata.antigravityCredits === true && creditsEnabled(context.config);

    if (useCredits) injectEnabledCreditTypes(body);
    // Gemini reasoning replay (signatures and native function calls of earlier turns), then the boundary turns.
    const replay = yield* prepareReplayPayload(ledger, baseModel, request, options, body);
    body = ensureBoundaryUserContent(baseModel, replay.payload);
    const accumulator = makeAccumulator(replay.scope, body);

    const project = attempt.project;
    const derivedSession = derivedAntigravitySessionId(options.metadata.derivedSessionId ?? "");
    body = geminiToAntigravity(
      baseModel,
      body,
      project,
      derivedSession,
      yield* Clock.currentTimeMillis,
    );
    const translatedForResponse = structuredClone(body);
    body = constrainRequestPayload(baseModel, body);

    const alt = options.alt === "responses/compact" ? "" : options.alt;
    const base = requestBaseUrl(context.credential.attributes, context.credential.metadata);
    let url = base + (upstreamStream ? ANTIGRAVITY_STREAM_PATH : ANTIGRAVITY_GENERATE_PATH);

    if (upstreamStream) url += alt === "" ? "?alt=sse" : `?$alt=${encodeURIComponent(alt)}`;
    else if (alt !== "") url += `?$alt=${encodeURIComponent(alt)}`;

    // User payload rules: the final semantic mutation of the business payload (AGENTS.md).
    const requestedModel =
      options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

    const finalBody = finalizePayload(
      context.config,
      ANTIGRAVITY_IDENTIFIER,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        root: "request",
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: originalTranslatedBody,
      },
      body,
    );

    return {
      url,
      headers: headersFor(attempt, agent),
      body: finalBody,
      baseModel,
      translated: translatedForResponse,
      useCredits,
      replayScope: replay.scope,
      replay: accumulator,
    } satisfies PreparedRequest;
  });

  const send = Effect.fnUntraced(function* (attempt: Attempt, prepared: PreparedRequest) {
    const { context, state } = attempt;
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

    if (response.status >= 200 && response.status < 300) return response;

    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    context.usage.fail(response.status, text);
    yield* clearReplayOnInvalidSignature(ledger, prepared.replayScope, response.status, text);

    if (response.status === 429) {
      const decision = decideAntigravity429(text);
      const now = yield* Clock.currentTimeMillis;

      const retryAfterMs = decision.retryAfterMs ?? 0;

      if (
        decision.kind === "short_cooldown_switch_auth" &&
        retryAfterMs > 0 &&
        !coolingDisabled(context)
      ) {
        yield* Effect.promise(() =>
          state.markShortCooldown(context.credential.id, prepared.baseModel, retryAfterMs, now),
        );
      } else if (
        decision.kind === "full_quota_exhausted" &&
        prepared.useCredits &&
        hasExplicitCreditsBalanceExhaustedReason(text) &&
        !coolingDisabled(context)
      ) {
        yield* Effect.promise(() => state.markCreditsExhausted(context.credential.id, now));
      }
    }

    return yield* antigravityStatusError(response.status, text, new Headers(response.headers));
  });

  const responseContext = (
    attempt: Attempt,
    prepared: PreparedRequest,
    alt: string | undefined,
  ): ResponseContext => ({
    model: attempt.request.model,
    originalRequest: attempt.options.originalRequest ?? attempt.request.payload,
    translatedRequest: prepared.translated,
    state: makeTranslationState(),
    ...(alt === undefined ? {} : { alt }),
  });

  const finishSuccess = (attempt: Attempt, prepared: PreparedRequest): Effect.Effect<void> =>
    prepared.useCredits
      ? Effect.promise(() =>
          attempt.state
            .setCredits(attempt.context.credential.id, {
              creditAmount: 1,
              minCreditAmount: 1,
              paidTierId: "",
              updatedAt: Date.now(),
            })
            .then(() => undefined),
        )
      : Effect.void;

  /** `resolveWebSearchGroundingURLs`: Vertex Search redirect URLs of web-search answers become their targets. */
  const resolveGrounding = (attempt: Attempt, prepared: PreparedRequest, payload: string) =>
    shouldResolveGroundingUrls(
      attempt.options.sourceFormat,
      attempt.options.originalRequest ?? attempt.request.payload,
      prepared.translated,
    )
      ? resolveGroundingUrlsInPayload(payload)
      : Effect.succeed(payload);

  /** Non-stream translation of an aggregated or plain upstream body. */
  const translateBody = (attempt: Attempt, prepared: PreparedRequest, upstreamText: string) =>
    Effect.gen(function* () {
      const { context, options } = attempt;
      const text = yield* resolveGrounding(attempt, prepared, upstreamText);
      const parsed = tryParseJson(text);
      context.usage.observeResponseModel(responseModelOf(parsed));
      const responseFormat = responseFormatOf(options);
      const ctx = responseContext(attempt, prepared, options.alt);

      const out = translating(attempt, () =>
        registry.translateNonStream(responseFormat, to, ctx, text),
      );

      yield* persistSignatures(attempt);

      if (out === undefined || out === "") {
        return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
      }

      context.usage.publish(parseAntigravityUsage(text));

      return responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out;
    });

  const executeGenerate = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolve(context, request, options);
    const baseModel = parseSuffix(request.model).modelName;
    yield* checkShortCooldown(attempt, baseModel);
    const agent = yield* userAgent(attempt);
    yield* maybeRefreshCredits(attempt, agent);
    const aggregate = aggregatesStream(baseModel);
    const prepared = yield* prepare(attempt, aggregate ? "aggregate" : "generate", agent);
    const response = yield* send(attempt, prepared);
    yield* finishSuccess(attempt, prepared);

    if (!aggregate) {
      const text = yield* response.text.pipe(Effect.mapError(transportError));

      // `cacheAntigravityReasoningReplayFromResponse`
      if (prepared.replay !== undefined) {
        const parsed = tryParseJson(text);

        if (parsed !== undefined) prepared.replay.observePayload(parsed);
        yield* prepared.replay.commit(ledger);
      }

      const payload = yield* translateBody(attempt, prepared, text);

      return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
    }

    // Claude, Gemini 3 Pro and image models only stream upstream: the SSE is merged into one response.
    const filter = new UsageFilter();

    const lines = yield* splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.runCollect,
    );

    const payloads: string[] = [];

    for (const line of lines) {
      prepared.replay?.observeLine(line);
      const payload = jsonPayloadOf(filter.filter(line));

      if (payload !== undefined) payloads.push(payload);
    }

    if (prepared.replay !== undefined) yield* prepared.replay.commit(ledger);
    const merged = JSON.stringify(convertStreamToNonStream(payloads));
    const payload = yield* translateBody(attempt, prepared, merged);

    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  /**
   * Sealed compaction items of the request (and the original request, falling back to the expanded request) become
   * developer context before anything else; an unreadable capsule is a request-scoped 400.
   */
  const expandCompaction = Effect.fnUntraced(function* (
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (!hasResponsesCompactionItem(request.payload)) return { request, options };

    const payload = yield* Effect.tryPromise({
      try: () => expandCompactionCapsules(request.payload),
      catch: (error) =>
        new ExecutionError({
          status: 400,
          message: error instanceof Error ? error.message : String(error),
          requestScoped: true,
        }),
    });

    const { originalRequest } = options;

    const original =
      originalRequest === undefined
        ? undefined
        : yield* Effect.promise(() =>
            expandCompactionCapsules(originalRequest).catch(() => payload),
          );

    return {
      request: { ...request, payload },
      options: original === undefined ? options : { ...options, originalRequest: original },
    };
  });

  const compactionRequested = (
    request: ExecutorRequest,
    options: ExecutorOptions,
    alt: boolean,
  ): boolean =>
    (alt && options.alt === "responses/compact") ||
    hasResponsesCompactionTrigger(request.payload) ||
    hasResponsesCompactionTrigger(options.originalRequest);

  /** `executeCompaction` (shared by the stream variant): non-stream summary turn sealed into a capsule. */
  const executeCompaction = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const baseModel = parseSuffix(request.model).modelName;

    const source =
      request.payload === undefined && options.originalRequest !== undefined
        ? options.originalRequest
        : request.payload;

    const summaryRequest: ExecutorRequest = {
      ...request,
      payload: prepareCompactionSummaryPayload(source),
    };

    const summaryOptions: ExecutorOptions = {
      ...options,
      alt: "",
      stream: false,
      originalRequest: undefined,
      sourceFormat: Formats.OpenAIResponse,
      responseFormat: Formats.OpenAIResponse,
    };

    const summary = yield* executeGenerate(context, summaryRequest, summaryOptions);
    const parsed = tryParseJson(summary.payload) ?? null;

    const text = yield* Effect.try({
      try: () => extractSummaryText(parsed),
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

    const usage = responsesSummaryUsage(parsed, summary.payload);

    return { baseModel, capsule, usage, headers: summary.headers };
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const expanded = yield* expandCompaction(request, options);

    if (compactionRequested(expanded.request, expanded.options, true)) {
      const sealed = yield* executeCompaction(context, expanded.request, expanded.options);

      const body = buildCompactionResponse(
        sealed.baseModel,
        sealed.capsule,
        sealed.usage.input,
        sealed.usage.output,
        sealed.usage.total,
        Date.now(),
      );

      return { payload: JSON.stringify(body), headers: sealed.headers } satisfies ExecutorResponse;
    }

    return yield* executeGenerate(context, expanded.request, expanded.options);
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.alt === "responses/compact") {
      return yield* new ExecutionError({
        status: 400,
        message: "streaming not supported for /responses/compact",
        requestScoped: true,
      });
    }

    const expanded = yield* expandCompaction(request, options);

    if (compactionRequested(expanded.request, expanded.options, false)) {
      const sealed = yield* executeCompaction(context, expanded.request, expanded.options);

      const chunks = buildCompactionStreamChunks(
        sealed.baseModel,
        sealed.capsule,
        sealed.usage.input,
        sealed.usage.output,
        sealed.usage.total,
        Date.now(),
      );

      const headers = new Headers(sealed.headers);
      headers.set("Content-Type", "text/event-stream");

      return { headers, chunks: Stream.fromIterable(chunks) } satisfies StreamResult;
    }

    return yield* executeGenerateStream(context, expanded.request, expanded.options);
  });

  const executeGenerateStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolve(context, request, options);
    const baseModel = parseSuffix(request.model).modelName;
    yield* checkShortCooldown(attempt, baseModel);
    const agent = yield* userAgent(attempt);
    yield* maybeRefreshCredits(attempt, agent);
    const prepared = yield* prepare(attempt, "stream", agent);
    const response = yield* send(attempt, prepared);
    yield* finishSuccess(attempt, prepared);

    const httpClient = yield* HttpClient.HttpClient;
    const responseFormat = responseFormatOf(options);
    // Streams always use SSE (`ctx alt = ""`) towards the translators.
    const ctx = responseContext(attempt, prepared, "");
    const filter = new UsageFilter();
    const assembler = new JsonAssembler();

    const translate = (payload: string): ReadonlyArray<string> =>
      translating(attempt, () => registry.translateStream(responseFormat, to, ctx, payload));

    const withToolInputCheck = (
      chunks: ReadonlyArray<string>,
    ): Stream.Stream<string, ExecutionError> =>
      ctx.state.toolInputError !== undefined
        ? Stream.concat(
            Stream.fromIterable(chunks),
            Stream.fail(new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })),
          )
        : Stream.fromIterable(chunks);

    const lines = splitLines(response.stream).pipe(Stream.mapError(transportError));

    const body = lines.pipe(
      Stream.flatMap((line) => {
        prepared.replay?.observeLine(line);
        // Accounting is captured before the client-facing filter renames usage.
        const usage = parseAntigravityStreamUsage(line);

        if (usage !== undefined) context.usage.publish(usage);
        const assembled = assembler.push(filter.filter(line));

        if (assembled.kind === "none") return Stream.empty;

        if (assembled.kind === "error") return Stream.fail(assembled.error);

        return Stream.unwrap(
          resolveGrounding(attempt, prepared, assembled.payload).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.map((payload) => {
              context.usage.observeResponseModel(responseModelOf(tryParseJson(payload)));
              const chunks = translate(payload);
              context.usage.observeTokenEvent(Date.now(), isGeminiTokenEvent(payload));

              // Responses clients: publish the ledger before the translated completion reaches them, so the next turn
              // finds it (split usage/signature frames may still extend the chain until `response.completed`).
              const commit =
                prepared.replay?.terminal === true &&
                !prepared.replay.committed &&
                responseFormat === Formats.OpenAIResponse &&
                chunks.some(isResponseCompleted)
                  ? prepared.replay.commit(ledger)
                  : Effect.void;

              return Stream.unwrap(commit.pipe(Effect.as(withToolInputCheck(chunks))));
            }),
          ),
        );
      }),
    );

    // Only a clean end of stream may produce a synthetic terminal event (a read error never reports success).
    // The ledger is committed before the EOF-generated completion is delivered.
    const tail = Stream.suspend(() => {
      const chunks = translate("[DONE]");

      const commit =
        prepared.replay !== undefined && !prepared.replay.committed
          ? prepared.replay.commit(ledger)
          : Effect.void;

      return Stream.unwrap(commit.pipe(Effect.as(withToolInputCheck(chunks))));
    });

    const chunks = Stream.concat(body, tail).pipe(
      Stream.ensuring(persistSignatures(attempt)),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolve(context, request, options);
    const thinking = yield* Thinking;
    const baseModel = parseSuffix(request.model).modelName;
    const from = options.sourceFormat;
    const agent = yield* userAgent(attempt);

    const original = validateRequestSignatures(
      baseModel,
      from,
      structuredClone(options.originalRequest ?? request.payload),
    );

    const texts =
      from === Formats.Claude
        ? translating(attempt, () => thinkingTextsNeedingCachedSignatures(baseModel, original))
        : [];

    const { kv } = attempt;

    if (texts.length > 0 && kv !== undefined) {
      yield* Effect.promise(() =>
        prefetchSignatures(attempt.signatures, makeKvSignatureStore(kv), baseModel, texts),
      );
    }

    const translated = translating(attempt, () =>
      translateRequestForExecutor(
        registry,
        from,
        to,
        {
          format: from,
          model: baseModel,
          stream: false,
          body: structuredClone(original),
          ...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
        },
        thinking.summary,
        { headers: options.headers, config: context.config },
      ),
    );

    if (translated.error !== undefined) return yield* requestError(translated);
    const originalTranslated = structuredClone(translated.body);

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider: ANTIGRAVITY_IDENTIFIER,
      source: original,
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup,
    });

    body = obfuscateSystemInstruction(
      body,
      context.config.oauth.providers.antigravity["sensitive-words"],
    );
    body = sanitizeGeminiRequestSignatures(baseModel, body);
    body = ensureLeadingUserContent(baseModel, body);

    for (const path of [
      "project",
      "model",
      "request.safetySettings",
      "request.toolConfig",
      "request.labels",
      "request.sessionId",
    ]) {
      del(body, path);
    }

    const alt = options.alt;
    const base = requestBaseUrl(context.credential.attributes, context.credential.metadata);

    const url =
      base + ANTIGRAVITY_COUNT_TOKENS_PATH + (alt !== "" ? `?$alt=${encodeURIComponent(alt)}` : "");

    const requestedModel =
      options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

    const finalBody = finalizePayload(
      context.config,
      ANTIGRAVITY_IDENTIFIER,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        root: "request",
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: originalTranslated,
      },
      body,
    );

    const prepared: PreparedRequest = {
      url,
      headers: headersFor(attempt, agent),
      body: finalBody,
      baseModel,
      translated: finalBody,
      useCredits: false,
      replayScope: NO_REPLAY_SCOPE,
      replay: undefined,
    };

    const response = yield* send(attempt, prepared);
    const text = yield* response.text.pipe(Effect.mapError(transportError));
    const count = asInt(get(tryParseJson(text), "totalTokens"));
    const payload = registry.translateTokenCount(responseFormatOf(options), to, count, text);

    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  return { identifier: ANTIGRAVITY_IDENTIFIER, execute, executeStream, countTokens };
};

/** Whether a translated Responses chunk carries the `response.completed` event. */
const isResponseCompleted = (chunk: string): boolean =>
  chunk.split("\n").some((line) => {
    const payload = jsonPayloadOf(line);

    return payload !== undefined && get(tryParseJson(payload), "type") === "response.completed";
  });

/** `JSONPayload`: the JSON object of an SSE `data:` line or raw JSON line. */
const jsonPayloadOf = (line: string): string | undefined => {
  let trimmed = line.trim();

  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined;

  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();

  return trimmed.startsWith("{") ? trimmed : undefined;
};

/** `obfuscateSensitiveWords` for the system instruction of a translated request. */
const obfuscateSystemInstruction = (body: Json, words: ReadonlyArray<string>): Json => {
  const obfuscate = buildSensitiveWordMatcher(words)?.obfuscate;

  if (obfuscate === undefined) return body;

  for (const path of ["request.systemInstruction", "request.system_instruction"]) {
    const instruction = get(body, path);

    if (instruction === undefined) continue;

    if (typeof instruction === "string") {
      const text = obfuscate(instruction);

      if (text !== instruction) set(body, path, text);
      continue;
    }

    const parts = get(instruction, "parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      if (!isJsonObject(part) || typeof part["text"] !== "string") continue;
      const text = obfuscate(part["text"]);

      if (text !== part["text"]) part["text"] = text;
    }
  }

  return body;
};

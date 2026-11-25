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
import { antigravitySessionIdForCredential } from "./derived-session.ts";
import { translateRequestForExecutor } from "../helps/translate.ts";
import { Clock, Effect, Option, Result, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  buildAntigravitySensitiveWordMatcher,
  obfuscateSystemInstruction,
} from "../helps/cloak-obfuscate.ts";
import { prepareClaudeStructuredOutput } from "./structured-output.ts";
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
import { normalizeAntigravityRequest } from "@commissary/translation";
import { fetchProjectId } from "../../oauth/flows/antigravity.ts";
import {
  type DeploymentKv,
  type OrgId,
  type OrgKv,
  WorkerExecutionContext,
} from "@commissary/core";
import { controlPlaneOf, optionalRequestOrg } from "@commissary/state";
import {
  type MemorySignatureCache,
  withSignatureContext,
  flushSignatureWrites,
  prefetchSignatures,
} from "@commissary/translation/signature";
import { makeKvSignatureStore, orgSignatureCache } from "../../signature/store.ts";
import {
  antigravitySignatureScope,
  scopedSignatureCache,
  scopedSignatureText,
} from "./signature-scope.ts";
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
  checkCompactionSource,
  compactionSummaryError,
  compactionSummaryStatusError,
  expandCompaction,
  extractSummaryText,
  hasResponsesCompactionTrigger,
  markLocalCompaction,
  prepareCompactionSummaryPayload,
  responsesSummaryUsage,
  sealSummaryCapsule,
} from "../helps/compaction.ts";
import { resolveGroundingUrlsInPayload, shouldResolveGroundingUrls } from "./grounding.ts";
import { creditsRecordFresh } from "./state.ts";
import { creditsEnabled, injectEnabledCreditTypes, probeCredits } from "./credits.ts";
import { NO_REPLAY_SCOPE, type ReplayAccumulator, type ReplayScope } from "./replay/accumulator.ts";
import { defaultReplayLedger, type ReplayLedger } from "../helps/reasoning-replay-ledger.ts";
import { chunksHaveTerminalCommitEvent } from "./replay/terminal.ts";
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
  needsSchemaSanitization,
  sanitizeRequestSchemas,
} from "./envelope.ts";
import {
  antigravityStatusError,
  decideAntigravity429,
  hasExplicitCreditsBalanceExhaustedReason,
} from "./errors.ts";
import { type AntigravityState, antigravityStateFor } from "./state.ts";
import {
  convertStreamToNonStream,
  inBandErrorStatus,
  JsonAssembler,
  UsageFilter,
} from "./stream.ts";
import {
  type ZeroOutputAction,
  zeroOutputError,
  zeroOutputErrorMessage,
  zeroOutputFinishReason,
  ZeroOutputStreamGuard,
} from "../helps/gemini-zero-output.ts";
import { antigravityRequestUserAgent, currentAntigravityVersion } from "./version.ts";
import { serializeAntigravityPayload } from "./payload-order.ts";
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
  /** The body as sent: compact, in the native key order for agent requests (`SerializeAntigravityPayload`). */
  readonly wire: string;
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
  /** The credential's scope within the org's signature cache (`signature-scope.ts`); `""` recovers nothing. */
  readonly signatureScope: string;
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
      signatures: orgSignatureCache(org),
      signatureScope: antigravitySignatureScope(context.credential.id, context.credential.metadata),
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
      {
        cache: scopedSignatureCache(attempt.signatures, attempt.signatureScope),
        settings: signatureSettings(attempt.context.config),
      },
      () => withModelInfoLookup(attempt.request.modelLookup, run),
    );

  /** Loads the credential's signatures for `texts` from KV; an attempt without a scope loads none. */
  const prefetchScopedSignatures = (
    attempt: Attempt,
    kv: OrgKv,
    modelName: string,
    texts: ReadonlyArray<string>,
  ): Promise<void> =>
    attempt.signatureScope === ""
      ? Promise.resolve()
      : prefetchSignatures(
          attempt.signatures,
          makeKvSignatureStore(kv),
          modelName,
          texts.map((text) => scopedSignatureText(attempt.signatureScope, text)),
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
  const checkShortCooldown = (attempt: Attempt, baseModel: string, countTokens = false) =>
    Effect.gen(function* () {
      const { context, options, state } = attempt;

      if (coolingDisabled(context)) return;

      // A token count never spends credits, so a cooling credential always refuses it (CLIProxyAPI 94b164bf).
      const bypass =
        !countTokens &&
        options.metadata.antigravityCredits === true &&
        creditsEnabled(context.config);

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

      const known = yield* Effect.promise(() => state.credits(context.credential.id));

      if (known !== undefined && creditsRecordFresh(known, now)) return;

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
      yield* Effect.promise(() => prefetchScopedSignatures(attempt, kv, baseModel, texts));
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

    body = applyAntigravitySensitiveWords(body, context.config);
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

    const credentialId = context.credential.id;

    const envelope = geminiToAntigravity(baseModel, body, attempt.project, {
      credentialId,
      org: attempt.org,
      sessionId: antigravitySessionIdForCredential(credentialId, {
        canonical: options.metadata.sessionId,
        execution: options.metadata.websocket?.sessionId,
        derived: options.metadata.derivedSessionId,
      }),
      now: yield* Clock.currentTimeMillis,
    });

    body = envelope.payload;
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
      context.usage,
    );

    // A payload rule may drop or change `requestType`: only an agent request keeps the agent key order.
    const requestType = get(finalBody, "requestType");

    const isAgent =
      envelope.isAgent &&
      (requestType === undefined ||
        (typeof requestType === "string" && requestType.trim() === "agent"));

    return {
      url,
      headers: headersFor(attempt, agent),
      body: finalBody,
      wire: serializeAntigravityPayload(finalBody, isAgent),
      baseModel,
      translated: translatedForResponse,
      useCredits,
      replayScope: replay.scope,
      replay: accumulator,
    } satisfies PreparedRequest;
  });

  /**
   * `applyAntigravityUpstreamError`: the bookkeeping of an upstream error, an HTTP error status or an in-band `error`
   * object of an HTTP 2xx body or stream frame (CLIProxyAPI ec25cc83): replay invalidation on a rejected signature,
   * the short cooldown or credits exhaustion of a 429, then the status error. A stream frame has no headers.
   */
  const upstreamError = Effect.fnUntraced(function* (
    attempt: Attempt,
    prepared: PreparedRequest,
    status: number,
    headers: Headers | undefined,
    text: string,
  ) {
    const { context, state } = attempt;
    context.usage.fail(status, text);
    yield* clearReplayOnInvalidSignature(ledger, prepared.replayScope, status, text);
    const now = yield* Clock.currentTimeMillis;

    if (status === 429) {
      const decision = decideAntigravity429(text, headers, now);

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

    return yield* antigravityStatusError(status, text, headers ?? new Headers(), now);
  });

  const send = Effect.fnUntraced(function* (attempt: Attempt, prepared: PreparedRequest) {
    const { context } = attempt;
    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.post(prepared.url).pipe(
      HttpClientRequest.bodyText(prepared.wire, "application/json"),
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

    return yield* upstreamError(
      attempt,
      prepared,
      response.status,
      new Headers(response.headers),
      text,
    );
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
    const responseFormat = responseFormatOf(options);

    /** An abnormal finish without visible output answered nothing (Go `CheckGeminiZeroOutputNonStream`). */
    const checkZeroOutput = (text: string) => {
      const reason = zeroOutputFinishReason(tryParseJson(text), true);

      if (reason === undefined) return Effect.void;
      const message = zeroOutputErrorMessage(responseFormat, reason);
      context.usage.publish(parseAntigravityUsage(text));
      context.usage.fail(502, message);

      return Effect.fail(zeroOutputError(message));
    };

    if (!aggregate) {
      const text = yield* response.text.pipe(Effect.mapError(transportError));
      // An in-band error of an HTTP 2xx body fails with its own status and bookkeeping (CLIProxyAPI ec25cc83).
      const status = inBandErrorStatus(tryParseJson(text));

      if (status !== undefined) {
        return yield* upstreamError(attempt, prepared, status, new Headers(response.headers), text);
      }

      yield* checkZeroOutput(text);
      const payload = yield* translateBody(attempt, prepared, text);

      // `cacheAntigravityReasoningReplayFromResponse`, once the translation succeeded (CLIProxyAPI 555bdb4b).
      if (prepared.replay !== undefined) {
        const parsed = tryParseJson(text);

        if (parsed !== undefined) prepared.replay.observeCompleted(parsed);
        yield* prepared.replay.commit(ledger);
      }

      yield* finishSuccess(attempt, prepared);

      return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
    }

    // Claude, Gemini 3 Pro and image models only stream upstream: the SSE is merged into one response. The chunks keep
    // their usage (no `UsageFilter`), so a stream without a terminal usage chunk still reports usage (Go `d5eb4ca1`).
    const lines = yield* splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.runCollect,
    );

    const assembler = new JsonAssembler();
    const payloads: string[] = [];

    for (const line of lines) {
      const payload = assembler.push(line);

      if (payload === undefined) continue;
      // A mid-stream error frame fails with its status and bookkeeping (CLIProxyAPI 892fc486, ec25cc83).
      const status = inBandErrorStatus(tryParseJson(payload));

      if (status !== undefined)
        return yield* upstreamError(attempt, prepared, status, undefined, payload);
      prepared.replay?.observeLine(payload);
      payloads.push(payload);
    }

    // An HTTP 200 without a single JSON frame answered nothing (CLIProxyAPI d1bdee85).
    if (payloads.length === 0) {
      const message = zeroOutputErrorMessage(responseFormat, "");
      context.usage.fail(502, message);

      return yield* zeroOutputError(message);
    }

    const merged = JSON.stringify(convertStreamToNonStream(payloads));
    yield* checkZeroOutput(merged);
    const payload = yield* translateBody(attempt, prepared, merged);

    // The ledger is written once the translation succeeded (CLIProxyAPI 555bdb4b).
    if (prepared.replay !== undefined) yield* prepared.replay.commit(ledger);
    yield* finishSuccess(attempt, prepared);

    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
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
    markLocalCompaction(options);

    const source =
      request.payload === undefined && options.originalRequest !== undefined
        ? options.originalRequest
        : request.payload;

    const sourceError = checkCompactionSource(source, options);

    if (sourceError !== undefined) return yield* sourceError;

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
    const statusError = compactionSummaryStatusError(parsed);

    if (statusError !== undefined) return yield* compactionSummaryError(statusError);

    const text = yield* Effect.try({
      try: () => extractSummaryText(parsed),
      catch: (error) =>
        compactionSummaryError(
          `extract summary: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const capsule = yield* sealSummaryCapsule(text, baseModel);

    const usage = responsesSummaryUsage(parsed, summary.payload);

    return { baseModel, capsule, usage, headers: summary.headers };
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const expanded = yield* expandCompaction(request, options, "drop-foreign");

    if (compactionRequested(expanded.request, expanded.options, true)) {
      const sealed = yield* executeCompaction(context, expanded.request, expanded.options);

      const body = buildCompactionResponse(
        sealed.baseModel,
        sealed.capsule,
        sealed.usage.input,
        sealed.usage.output,
        sealed.usage.total,
        Date.now(),
        // The summary's cached and reasoning tokens are kept (CLIProxyAPI dc2455d9).
        { cached: sealed.usage.cached, reasoning: sealed.usage.reasoning },
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

    const expanded = yield* expandCompaction(request, options, "drop-foreign");

    if (compactionRequested(expanded.request, expanded.options, false)) {
      const sealed = yield* executeCompaction(context, expanded.request, expanded.options);

      const chunks = buildCompactionStreamChunks(
        sealed.baseModel,
        sealed.capsule,
        sealed.usage.input,
        sealed.usage.output,
        sealed.usage.total,
        Date.now(),
        // The summary's cached and reasoning tokens are kept (CLIProxyAPI dc2455d9).
        { cached: sealed.usage.cached, reasoning: sealed.usage.reasoning },
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

    const httpClient = yield* HttpClient.HttpClient;
    const responseFormat = responseFormatOf(options);
    // Streams always use SSE (`ctx alt = ""`) towards the translators.
    const ctx = responseContext(attempt, prepared, "");
    const filter = new UsageFilter();
    const assembler = new JsonAssembler();
    // Go cf07c78a, f2efe2c4: withholds leading contentless frames (the `response` envelope included) and fails an
    // abnormal zero-output finish before them, while the handler can still fail over.
    const guard = new ZeroOutputStreamGuard(responseFormat, true);
    let sawUpstreamJson = false;

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

    /** Translates one upstream payload for the client, its usage filtered after the guard classified it. */
    const emitPayload = (raw: string): Stream.Stream<string, ExecutionError> => {
      const filtered = filter.filter(raw);

      if (filtered.trim() === "") return Stream.empty;

      return Stream.unwrap(
        resolveGrounding(attempt, prepared, filtered).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.map((payload) => {
            context.usage.observeResponseModel(responseModelOf(tryParseJson(payload)));
            const chunks = translate(payload);
            context.usage.observeTokenEvent(Date.now(), isGeminiTokenEvent(payload));

            if (chunks.some((chunk) => chunk !== "")) guard.markEmitted();

            // Publish the ledger before any client-visible terminal event (`response.completed`, a chat `finish_reason`,
            // `message_stop`, ...) reaches the client, so the next turn finds it (Go cc95661c, `antigravityStreamChunks
            // HaveTerminalCommitEvent`). As in Go this is the `finishReason` frame: a signature or call frame that
            // arrives after it is not captured (a stream that keeps sending after its finish reason is not expected).
            const commit =
              prepared.replay?.terminal === true &&
              !prepared.replay.committed &&
              chunksHaveTerminalCommitEvent(chunks)
                ? prepared.replay.commit(ledger)
                : Effect.void;

            return Stream.unwrap(commit.pipe(Effect.as(withToolInputCheck(chunks))));
          }),
        ),
      );
    };

    const emitAll = (
      frames: ReadonlyArray<string>,
      then: Stream.Stream<string, ExecutionError> = Stream.empty,
    ): Stream.Stream<string, ExecutionError> =>
      Stream.concat(Stream.fromIterable(frames).pipe(Stream.flatMap(emitPayload)), then);

    const failZeroOutput = (finishReason: string) =>
      Stream.fail(zeroOutputError(zeroOutputErrorMessage(responseFormat, finishReason)));

    /** Applies a guard decision; `frame` is the current payload, if any. */
    const guarded = (
      action: ZeroOutputAction,
      frame: string | undefined,
    ): Stream.Stream<string, ExecutionError> => {
      switch (action.kind) {
        case "continue":
          return Stream.empty;
        case "fail":
          return failZeroOutput(action.finishReason);
        case "emit-error-then-fail":
          return emitAll([action.frame], failZeroOutput(action.finishReason));
        case "emit":
          return emitAll(frame === undefined ? action.flush : [...action.flush, frame]);
      }
    };

    const lines = splitLines(response.stream).pipe(Stream.mapError(transportError));

    const body = lines.pipe(
      Stream.flatMap((line) => {
        const payload = assembler.push(line);

        if (payload === undefined) return Stream.empty;
        sawUpstreamJson = true;
        // Accounting is captured before the client-facing filter renames usage.
        const usage = parseAntigravityStreamUsage(payload);

        if (usage !== undefined) context.usage.publish(usage);
        const root = tryParseJson(payload);
        // A mid-stream error frame fails with its status and bookkeeping (CLIProxyAPI 892fc486, ec25cc83).
        const status = inBandErrorStatus(root);

        if (status !== undefined)
          return Stream.fromEffect(upstreamError(attempt, prepared, status, undefined, payload));
        prepared.replay?.observeLine(payload);

        return guarded(guard.observe(payload, root), payload);
      }),
    );

    // Only a clean end of stream may produce a synthetic terminal event (a read error never reports success).
    // The ledger is committed before the EOF-generated completion is delivered.
    const tail = Stream.suspend(() => {
      // An HTTP 200 stream without a single JSON frame answered nothing (CLIProxyAPI 20be744e).
      if (!sawUpstreamJson) return failZeroOutput("");
      const action = guard.finalize();

      if (action.kind !== "emit") return guarded(action, undefined);

      const done = Stream.suspend(() => {
        const chunks = translate("[DONE]");

        const commit =
          prepared.replay !== undefined && !prepared.replay.committed
            ? prepared.replay.commit(ledger)
            : Effect.void;

        return Stream.unwrap(
          commit.pipe(
            Effect.andThen(finishSuccess(attempt, prepared)),
            Effect.as(withToolInputCheck(chunks)),
          ),
        );
      });

      return emitAll(action.flush, done);
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
    yield* checkShortCooldown(attempt, baseModel, true);
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
      yield* Effect.promise(() => prefetchScopedSignatures(attempt, kv, baseModel, texts));
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

    body = applyAntigravitySensitiveWords(body, context.config);
    // The schema is counted as the prompt it is sent as (CLIProxyAPI 1d45a5f3), in the native wire format (38067a29).
    prepareClaudeStructuredOutput(baseModel, body);
    normalizeAntigravityRequest(body);
    body = sanitizeGeminiRequestSignatures(baseModel, body);
    // The reasoning replay of the counted request: the ledger is peeked, never reserved or invalidated (Go
    // `prepareAntigravityGeminiCountTokensReasoningReplayPayloadDoc`).
    body = (yield* prepareReplayPayload(ledger, baseModel, request, options, body, {
      reserve: false,
    })).payload;
    body = ensureLeadingUserContent(baseModel, body);
    // `countTokens` needs the tokenizer model once the top-level `model` is gone (CLIProxyAPI fb989e5f).
    const requestModel = get(body, "request.model");

    if (typeof requestModel !== "string" || requestModel.trim() === "") {
      const model = countTokensModel(baseModel);

      if (model !== "") set(body, "request.model", model);
    }

    for (const path of [
      "project",
      "model",
      "request.safetySettings",
      "request.toolConfig",
      "request.labels",
      "request.sessionId",
      "request.stream",
    ]) {
      del(body, path);
    }

    // The schemas are cleaned as for a generate request (CLIProxyAPI 94b164bf).
    if (needsSchemaSanitization(body)) {
      const lower = baseModel.toLowerCase();
      const isClaudeModel = lower.includes("claude");

      sanitizeRequestSchemas(body, {
        useAntigravitySchema:
          isClaudeModel || lower.includes("gemini-3-pro") || lower.includes("gemini-3.1-pro"),
        isClaudeModel,
      });
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
      context.usage,
    );

    const prepared: PreparedRequest = {
      url,
      headers: headersFor(attempt, agent),
      body: finalBody,
      wire: JSON.stringify(finalBody),
      baseModel,
      translated: finalBody,
      useCredits: false,
      replayScope: NO_REPLAY_SCOPE,
      replay: undefined,
    };

    const response = yield* send(attempt, prepared);
    const raw = yield* response.text.pipe(Effect.mapError(transportError));
    const headers = new Headers(response.headers);

    // A 200 must be one JSON object with a count, else it is an upstream failure (CLIProxyAPI 9bce4825).
    const invalid = (message: string) => {
      context.usage.fail(502, message);

      return new ExecutionError({ status: 502, message });
    };

    if (raw.length > COUNT_TOKENS_MAX_RESPONSE_BYTES) {
      return yield* invalid(
        `antigravity count_tokens response exceeded ${COUNT_TOKENS_MAX_RESPONSE_BYTES} bytes`,
      );
    }

    const root = raw.trim().startsWith("{") ? tryParseJson(raw) : undefined;

    if (!isJsonObject(root))
      return yield* invalid("antigravity count_tokens response is not a valid JSON object");
    // An in-band error answers with its own status and 429 bookkeeping (CLIProxyAPI 4087007c).
    const status = inBandErrorStatus(root);

    if (status !== undefined) return yield* upstreamError(attempt, prepared, status, headers, raw);
    const total = root["totalTokens"];

    if (typeof total !== "number")
      return yield* invalid("antigravity count_tokens response missing numeric totalTokens");

    if (!Number.isSafeInteger(total) || total < 0)
      return yield* invalid("antigravity count_tokens response has invalid totalTokens");
    const payload = registry.translateTokenCount(responseFormatOf(options), to, total, raw);

    return { payload, headers } satisfies ExecutorResponse;
  });

  return { identifier: ANTIGRAVITY_IDENTIFIER, execute, executeStream, countTokens };
};

/** `antigravityCountTokensMaxResponseBytes`: the largest `countTokens` body accepted (1 MiB). */
const COUNT_TOKENS_MAX_RESPONSE_BYTES = 1 << 20;

/** `formatAntigravityCountTokensModel`: a bare model id becomes `models/<id>`; resource names stay as they are. */
const countTokensModel = (model: string): string => {
  const trimmed = model.trim();

  if (trimmed === "") return "";

  return /^(models|projects|publishers)\//.test(trimmed) ? trimmed : `models/${trimmed}`;
};

/** `AntigravityExecutor.obfuscateSensitiveWordsDoc`: the configured words and replacements in the system instruction. */
const applyAntigravitySensitiveWords = (body: Json, config: Config): Json => {
  const settings = config.oauth.providers.antigravity;

  const matcher = buildAntigravitySensitiveWordMatcher({
    words: settings["sensitive-words"],
    replacements: settings["sensitive-words-replace"],
    patterns: settings["sensitive-patterns-replace"],
  });

  return matcher === undefined ? body : obfuscateSystemInstruction(body, matcher);
};

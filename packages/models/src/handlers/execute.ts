/**
 * Shared execution pipeline for all entry protocols: resolve model/providers -> pick credential -> resolve the
 * credential's upstream model -> run the provider executor -> report the attempt -> publish usage.
 *
 * Go source: sdk/api/handlers/handlers_execution.go (ExecuteWithAuthManager, executionErrorMessage),
 * sdk/api/handlers/handlers_stream.go (ExecuteStreamWithAuthManager), sdk/api/handlers/handlers.go
 * (requestExecutionMetadata), sdk/api/handlers/handlers_errors.go (enrichAuthSelectionError),
 * sdk/cliproxy/auth/conductor_execution.go (Execute/ExecuteStream), sdk/api/handlers/handlers_stream.go (bootstrap
 * retries). The retry rounds, cooldown waits and failover live in `conductor.ts`; this module supplies what is specific
 * to non-stream and stream execution (stream bootstrap, force-mapping rewrite, per-attempt reporting).
 */
import { Cause, Effect, Exit, Pull, Scope, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";
import { AccessPrincipal, isSharedAgentRun, usageRunOf } from "@commissary/auth";
import { ConfigReader } from "../config/reader.ts";
import type { Config } from "../config/schema.ts";
import { ExecutionError, withErrorFields } from "../executor/errors.ts";
import type { CredentialSnapshot } from "../executor/picker.ts";
import type { ExecutionMetadata, ExecutorOptions, WebsocketExecution } from "../executor/types.ts";
import { filterUpstreamHeaders } from "../http/headers.ts";
import { get, type Json } from "@commissary/json";
import { EntryOnlyFormats, type Format } from "@commissary/translation/formats";
import { CurrentOrg } from "@commissary/core";
import {
  type Attempt,
  attemptOptions,
  conduct,
  lifecycleError,
  type Prepared,
} from "./conductor.ts";
import { metered } from "./metering.ts";
import { rewriteResponseModel, rewriteStreamChunk } from "./model-rewrite.ts";
import { resolveModel } from "./resolve.ts";
import { prepareSessionRouting, type SessionRouting } from "../session-routing/routing.ts";
import { extractSessionInfo } from "./session.ts";
import type { ModelsEnv } from "../env.ts";

export interface ExecutionInput {
  /** Entry protocol (handler type), passed to executors as `sourceFormat`. */
  readonly entryProtocol: Format;
  /** Response protocol when it differs from the entry protocol. */
  readonly responseFormat?: Format;
  /** Model string as sent by the client. */
  readonly model: string;
  /** Body to execute (entry-protocol format). */
  readonly body: Json;
  /** The client's body before handler rewrites (defaults to `body`). */
  readonly originalRequest?: Json;
  readonly alt: string;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly allowImageModel?: boolean;
  readonly allowSpeechModel?: boolean;
  /** Skip free-plan Codex credentials (image tools). */
  readonly disallowFreeAuth?: boolean;
  /** Skips provider lookup and routes to this provider (Interactions `agent` requests, Go `ForcedProvider`). */
  readonly forcedProvider?: string;
  /** Select the credential as if for this model while executing `model` (Go `auth_selection_model`). */
  readonly authSelectionModel?: string;
  /** Require this credential (xAI video retrieval is bound to the credential that created the video). */
  readonly pinnedId?: string;
  /** The request arrives over the Responses WebSocket: prefer `websockets` credentials and tell the executor. */
  readonly websocket?: WebsocketExecution;
  /** Called with each credential an attempt runs on (Go `WithSelectedAuthIDCallback`). */
  readonly onSelected?: (credential: CredentialSnapshot) => void;
  /** File parts of a multipart System One request (`ExecutorOptions.systemOneParts`). */
  readonly systemOneParts?: ReadonlyMap<string, File>;
}

export interface ExecutionOutput {
  readonly payload: string;
  /** Binary body (audio) when the executor returned one; `payload` is empty then. */
  readonly bytes?: Uint8Array | undefined;
  /** The credential that served the request (xAI video binding). */
  readonly credentialId: string;
  /** Filtered upstream headers when `passthrough-headers` is enabled. */
  readonly headers: Headers | undefined;
}

export interface StreamOutput {
  readonly chunks: Stream.Stream<string, ExecutionError>;
  readonly headers: Headers | undefined;
}

const stringField = (body: Json, path: string): string | undefined => {
  const value = get(body, path);

  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** `requestExecutionMetadata` (subset). `sessionId` is the explicit session identity, when the request carries one. */
export const executionMetadata = (
  input: ExecutionInput,
  callerScope: string,
  requestPath: string,
  headers: Headers,
  sessionId?: string,
  derivedSessionId?: string,
): ExecutionMetadata => {
  const idempotencyKey = headers.get("idempotency-key") ?? undefined;

  const reasoningEffort =
    stringField(input.body, "reasoning_effort") ?? stringField(input.body, "reasoning.effort");

  return {
    requestPath,
    requestedModel: input.model,
    serviceTier: stringField(input.body, "service_tier") ?? "auto",
    generate: get(input.body, "generate") !== false,
    callerScope,
    ...(idempotencyKey !== undefined && idempotencyKey !== "" ? { idempotencyKey } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(derivedSessionId !== undefined ? { derivedSessionId } : {}),
    ...(input.websocket !== undefined ? { websocket: input.websocket } : {}),
  };
};

/** `enrichAuthSelectionError`: adds providers/model to "no credential" errors. */
export const enrichSelectionError = (
  error: ExecutionError,
  providers: ReadonlyArray<string>,
  model: string,
): ExecutionError => {
  if (error.code !== "auth_not_found" && error.code !== "auth_unavailable") return error;
  const providerText = providers.length > 0 ? providers.join(",") : "unknown";
  const modelText = model.trim() !== "" ? model.trim() : "unknown";
  const base = error.message.trim() !== "" ? error.message.trim() : "no auth available";
  let message = `${base} (providers=${providerText}, model=${modelText})`;

  if (`,${providerText},`.includes(",claude,")) {
    message += "; check Claude auth/key session and cooldown state via /v0/management/auth-files";
  }

  return withErrorFields(error, { message, status: error.status > 0 ? error.status : 503 });
};

const toExecutionError = (cause: Cause.Cause<ExecutionError>): ExecutionError | undefined => {
  const failure = cause.reasons.find(Cause.isFailReason);

  return failure?.error;
};

const prepare = Effect.fnUntraced(function* (input: ExecutionInput, stream: boolean) {
  const identity = yield* AccessPrincipal;
  const org = yield* CurrentOrg;
  const run = usageRunOf(identity.principal);

  const { config } = yield* (yield* ConfigReader).get.pipe(
    Effect.mapError(
      (cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }),
    ),
  );

  const resolved =
    input.forcedProvider !== undefined
      ? { providers: [input.forcedProvider], model: input.model }
      : yield* resolveModel(input.model, {
          entryProtocol: input.entryProtocol,
          ...(input.allowImageModel !== undefined
            ? { allowImageModel: input.allowImageModel }
            : {}),
          ...(input.allowSpeechModel !== undefined
            ? { allowSpeechModel: input.allowSpeechModel }
            : {}),
        });

  const url = new URL(input.request.url, "http://localhost");
  const headers = new Headers(input.request.headers);
  const originalRequest = input.originalRequest ?? input.body;
  // System One requests (ADR 0032) have no sessions, and nothing of their state may be derived into one (ADR 0027).
  const systemOne = input.entryProtocol === EntryOnlyFormats.SystemOne;
  const sessionInfo = systemOne ? undefined : extractSessionInfo(headers, originalRequest);

  const routing: SessionRouting = systemOne
    ? {}
    : prepareSessionRouting({
        headers,
        body: originalRequest,
        format: input.entryProtocol,
        callerScope: identity.callerScope,
        explicit: sessionInfo,
        affinity: config.routing["session-affinity"],
      });

  const options: ExecutorOptions = {
    stream,
    alt: input.alt,
    headers,
    query: url.searchParams,
    originalRequest,
    sourceFormat: input.entryProtocol,
    ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
    ...(input.systemOneParts !== undefined ? { systemOneParts: input.systemOneParts } : {}),
    metadata: executionMetadata(
      input,
      identity.callerScope,
      url.pathname,
      headers,
      sessionInfo?.sessionId,
      routing.derivedId,
    ),
  };

  return {
    config,
    providers: resolved.providers,
    routeModel: resolved.model,
    body: input.body,
    clientModel: input.model,
    options,
    stream,
    principalId: identity.principalId,
    orgId: org,
    ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
    ...(identity.principal.kind === "key" ? { apiKeyId: identity.principal.keyId } : {}),
    // A shared agent's run acts as the agent (ADR 0040): selection gives it every shared credential.
    ...(isSharedAgentRun(identity.principal) ? { agentId: identity.principal.agentId } : {}),
    ...(run === undefined ? {} : { run }),
    callerScope: identity.callerScope,
    endpoint: `${input.request.method} ${url.pathname}`,
    session:
      sessionInfo === undefined
        ? undefined
        : {
            id: sessionInfo.sessionId,
            ...(sessionInfo.parentSessionId === undefined
              ? {}
              : { parentId: sessionInfo.parentSessionId }),
            ...(sessionInfo.isFork ? { isFork: true } : {}),
          },
    routing,
    ...(input.disallowFreeAuth === true ? { disallowFreeAuth: true } : {}),
    ...(input.authSelectionModel === undefined ? {} : { selectionModel: input.authSelectionModel }),
    ...(input.pinnedId !== undefined ? { pinnedId: input.pinnedId } : {}),
    ...(input.websocket !== undefined ? { preferWebsockets: true } : {}),
    ...(input.onSelected !== undefined ? { onSelected: input.onSelected } : {}),
  } satisfies Prepared;
});

const upstreamHeaders = (config: Config, headers: Headers): Headers | undefined =>
  config.requests["passthrough-headers"] ? filterUpstreamHeaders(headers) : undefined;

/** Final error of a failed execution: selection errors name the providers and model (`enrichAuthSelectionError`). */
const finalError = (prepared: Prepared, error: ExecutionError): ExecutionError =>
  enrichSelectionError(error, prepared.providers, prepared.routeModel);

/**
 * Non-streaming execution (Go `ExecuteWithAuthManager`) without counting it against free usage: for what is not a
 * Request (GLOSSARY), such as polling a video's status.
 */
export const executeNonStreamUnmetered = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, false);

  const result = yield* conduct(prepared, (attempt) =>
    Effect.gen(function* () {
      const response = yield* attempt.executor.execute(
        attempt.context,
        attempt.request,
        attemptOptions(prepared, attempt),
      );

      yield* attempt.finish(undefined, response.headers);

      return {
        payload:
          attempt.rewriteTo === "" || response.bytes !== undefined
            ? response.payload
            : rewriteResponseModel(response.payload, attempt.rewriteTo),
        ...(response.bytes !== undefined ? { bytes: response.bytes } : {}),
        credentialId: attempt.picked.credential.id,
        headers: upstreamHeaders(prepared.config, response.headers),
      } satisfies ExecutionOutput;
    }),
  );

  if (!result.ok) return yield* finalError(prepared, result.error);

  return result.value;
});

/** Non-streaming execution (Go `ExecuteWithAuthManager`) of a Request, counted against free usage (`metering.ts`). */
export const executeNonStream = (input: ExecutionInput) =>
  metered(executeNonStreamUnmetered(input));

const NO_CHUNKS: ReadonlyArray<string> = [];

/** Reads until the first non-empty chunk (`readStreamBootstrap`). `closed` = the stream ended. */
const readBootstrap = (pull: Pull.Pull<ReadonlyArray<string>, ExecutionError>) =>
  Effect.gen(function* () {
    const buffered: string[] = [];
    let received = false;

    while (true) {
      const next = yield* pull.pipe(
        Effect.map((chunk) => ({ closed: false, chunk }) as const),
        Pull.catchDone(() => Effect.succeed({ closed: true, chunk: NO_CHUNKS } as const)),
      );

      if (next.closed) return { buffered, closed: true, received };
      received = true;
      buffered.push(...next.chunk);

      if (next.chunk.some((text) => text !== "")) return { buffered, closed: false, received };
    }
  });

/**
 * One streaming attempt: opens the stream and waits for the first payload. Failures before it are failovers; after it
 * the stream is handed to the client and the attempt is reported when the stream ends (Go `wrapStreamResult`).
 */
const runStreamAttempt = (prepared: Prepared, attempt: Attempt) =>
  Effect.gen(function* () {
    prepared.onSelected?.(attempt.context.credential);

    const result = yield* attempt.executor.executeStream(
      attempt.context,
      attempt.request,
      attemptOptions(prepared, attempt),
    );

    // The pull lives in a child of the request scope: failed attempts close it, the winner stays open until the
    // response body is consumed.
    const parent = yield* Scope.Scope;
    const child = Scope.forkUnsafe(parent);
    const pull = yield* Stream.toPull(result.chunks).pipe(Scope.provide(child));
    const abandon = Scope.close(child, Exit.void);

    const boot = yield* readBootstrap(pull).pipe(
      Effect.tapError(() =>
        Effect.sync(() => (attempt.bootstrapFailed = true)).pipe(Effect.andThen(abandon)),
      ),
    );

    if (boot.closed && !boot.received) {
      attempt.bootstrapFailed = true;
      yield* abandon;

      return yield* new ExecutionError({
        status: 500,
        code: "empty_stream",
        message: "upstream stream closed before first payload",
      });
    }

    const services = yield* Effect.context<ModelsEnv | CurrentOrg>();
    const target = attempt.rewriteTo;
    const rest = boot.closed ? Stream.empty : Stream.fromPull(Effect.succeed(pull));

    const chunks = Stream.concat(Stream.fromIterable(boot.buffered), rest).pipe(
      Stream.map((text) => (target === "" ? text : rewriteStreamChunk(text, target))),
      Stream.onExit((exit) => {
        const failure = Exit.isFailure(exit) ? toExecutionError(exit.cause) : undefined;
        const interrupted = Exit.isFailure(exit) && failure === undefined;

        return attempt
          .finish(interrupted ? lifecycleError() : failure, result.headers)
          .pipe(Effect.provideContext(services));
      }),
    );

    return {
      chunks,
      headers: upstreamHeaders(prepared.config, result.headers),
    } satisfies StreamOutput;
  });

/** `bootstrapEligible`: errors before the first byte that a fresh attempt may overcome. */
const bootstrapEligible = (status: number): boolean =>
  status === 0 || [401, 402, 403, 408, 429].includes(status) || status >= 500;

/**
 * Streaming execution (Go `ExecuteStreamWithAuthManager`). Failover across credentials happens only before the first
 * payload chunk; `requests.streaming.bootstrap-retries` repeats the whole execution for bootstrap failures.
 */
export const executeStream = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, true);
  const maxBootstrapRetries = Math.max(0, prepared.config.requests.streaming["bootstrap-retries"]);

  for (let retries = 0; ; retries += 1) {
    const result = yield* conduct(prepared, (attempt) => runStreamAttempt(prepared, attempt));

    if (result.ok) return result.value;

    if (
      !result.bootstrap ||
      retries >= maxBootstrapRetries ||
      !bootstrapEligible(result.error.status)
    ) {
      return yield* finalError(prepared, result.error);
    }
  }
}, metered);

/**
 * Token counting (Go `ExecuteCountWithAuthManager`): the same retry/failover conductor as non-stream execution, through
 * the provider's `countTokens`. Count requests carry no billable tokens and skip the passive quota snapshot; they are
 * not Requests (GLOSSARY), so they are not counted against free usage either.
 */
export const executeCountTokens = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared: Prepared = { ...(yield* prepare(input, false)), countTokens: true };

  const result = yield* conduct(prepared, (attempt) =>
    Effect.gen(function* () {
      const response = yield* attempt.executor.countTokens(
        attempt.context,
        attempt.request,
        attemptOptions(prepared, attempt),
      );

      yield* attempt.finish(undefined, response.headers);

      return {
        payload: response.payload,
        credentialId: attempt.picked.credential.id,
        headers: upstreamHeaders(prepared.config, response.headers),
      } satisfies ExecutionOutput;
    }),
  );

  if (!result.ok) return yield* finalError(prepared, result.error);

  return result.value;
});

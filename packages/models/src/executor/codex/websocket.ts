/**
 * Codex Responses WebSocket transport (upstream), used for downstream WebSocket requests with a credential that has
 * `websockets` enabled.
 *
 * Go source: internal/runtime/executor/codex_websockets_executor.go (CodexAutoExecutor routing, codexWebsocketsEnabled),
 * codex_websockets_stream.go (ExecuteStream, prepareCodexWebsocketStream; usage-limit failover: 86a1aabf), codex_websockets_request.go
 * (applyCodexWebsocketHeaders), codex_websockets_connection.go (buildCodexResponsesWebsocketURL,
 * frameCodexWebsocketRequestBody), codex_websockets_errors.go (parseCodexWebsocketError, normalizeCodexWebsocketCompletion),
 * codex_websockets_session.go (sessions: see `../websocket/session.ts`).
 *
 * The request pipeline is the HTTP one (`executor.ts` `prepare`, websocket mode: `previous_response_id`, `generate` and
 * `stream_options` are kept) followed by transport framing only: `type: "response.create"` is the last, non-business
 * mutation. Upstream events are forwarded as bare JSON chunks (Go skips response translation for downstream
 * WebSockets); terminal events get the same normalisation as the SSE path (`response.done` -> `response.completed`,
 * rebuilt `response.output`, usage detail objects).
 *
 * Stream bootstrap buffering follows `codex_websockets_stream.go` (every message read spends the frame budget).
 *
 * Response steering / full duplex (`upstream.codex.response-steering`, off by default) is `duplex.ts`; non-stream execution over
 * WebSocket aggregates the Responses events (`executor.ts` `execute`).
 */
import { Clock, Data, Effect, Option, Stream } from "effect";
import { restoreCodexMultiAgentV2Response } from "../helps/codex-multi-agent-v2.ts";
import {
  asInt,
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { statusText } from "../../http/status.ts";
import { responseModelOf } from "../../usage/record.ts";
import { isResponsesTokenEvent } from "../../usage/ttft.ts";
import { ErrorCode } from "../../credentials/cooldown/classify.ts";
import { ExecutionError } from "../errors.ts";
import { parseRetryAfterMs } from "../helps/retry-after.ts";
import type { Thinking } from "../thinking.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  StreamResult,
} from "../types.ts";
import { websocketUrl } from "../websocket/connector.ts";
import {
  codexSessionStore,
  type OpenTurnInput,
  openTurn,
  type UpstreamSessionStore,
} from "../websocket/session.ts";
import { isCompatModel } from "./compat.ts";
import { startCodexDuplex } from "./duplex.ts";
import {
  codexEmptyIncompleteStreamError,
  codexErrorEventHeaders,
  codexErrorIsContextLength,
  codexPolicyFallbackMessage,
  codexResponseEventType,
  codexStatusErrorClassification,
  codexTerminalFailure,
  codexTerminalFailureBody,
  codexTerminalFailureStatus,
  codexTopLevelErrorBody,
  isCodexTransientCapacityError,
  isCodexUsageLimitError,
  isThinkingSignatureInvalid,
  newCodexStatusError,
  parseCodexRetryAfterMs,
  shouldParseCodexRetryAfterHeader,
} from "./errors.ts";
import type { PreparedRequest } from "./executor.ts";
import { codexBaseUrl } from "./headers.ts";
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  normalizeCodexCompletion,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput,
} from "./output.ts";
import {
  BOOTSTRAP_MAX_BUFFERED_BYTES,
  BOOTSTRAP_MAX_BUFFERED_FRAMES,
  bootstrapOverloadError,
  bootstrapTimeoutMs,
  isBootstrapBufferableEvent,
  isOverloadBootstrapFailure,
} from "./bootstrap.ts";
import type { CodexReplayStore } from "./replay.ts";
import { cacheReplayFromCompleted } from "./replay.ts";

/** Go `strconv.ParseBool` (the subset of spellings Go accepts, lower/upper case variants included). */
const parseBool = (raw: string): boolean | undefined => {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true;
    case "0":
    case "f":
    case "false":
      return false;
    default:
      return undefined;
  }
};

/** Classification of one upstream message: a failure to surface, or the chunks to forward. */
type Outcome = Data.TaggedEnum<{
  failure: {
    readonly error: ExecutionError;
    /** Where the failure came from: an upstream `error` frame, a terminal failure event, an empty incomplete. */
    readonly kind: "ws" | "terminal" | "empty";
    readonly body: string;
    readonly overload: boolean;
  };
  frame: {
    readonly chunks: ReadonlyArray<string>;
    readonly terminal: boolean;
    readonly bufferable: boolean;
    readonly bytes: number;
  };
}>;

const Outcome = Data.taggedEnum<Outcome>();

/** `codexWebsocketsEnabled`: the `websockets` attribute, else the metadata flag (Go `ParseBool` / bool). */
export const codexWebsocketsEnabled = (credential: {
  readonly attributes: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, Json>>;
}): boolean => {
  const attribute = (credential.attributes["websockets"] ?? "").trim();

  if (attribute !== "") {
    const parsed = parseBool(attribute);

    if (parsed !== undefined) return parsed;
  }

  const raw = credential.metadata["websockets"];

  if (typeof raw === "boolean") return raw;

  if (typeof raw === "string") return parseBool(raw) ?? false;

  return false;
};

/** `frameCodexWebsocketRequestBody`: the request JSON with `type: "response.create"`. */
export const frameCodexWebsocketBody = (body: Json): string =>
  JSON.stringify(isJsonObject(body) ? { ...body, type: "response.create" } : body);

const CONNECTION_LIMIT_PATHS = [
  "error.code",
  "error.type",
  "body.error.code",
  "body.error.type",
  "code",
  "error",
] as const;

const isConnectionLimitError = (event: Json | undefined): boolean =>
  CONNECTION_LIMIT_PATHS.some(
    (path) => asString(get(event, path)).trim() === "websocket_connection_limit_reached",
  );

/**
 * `buildCodexWebsocketErrorPayload`: `{"type":"error","status":N,...}` with the event's `sequence_number`, `body` and
 * error object (from `body.error`, `error`, `response.error` or the top-level `code`/`message`). A string error becomes
 * `{"message": ...}`, and a blank message is filled from the code (policy copy), the type or the status text
 * (Go 1f76e479, 20df0c25).
 */
const websocketErrorBody = (event: Json | undefined, status: number): JsonObject => {
  const out: JsonObject = { type: "error", status };
  const sequence = get(event, "sequence_number");

  if (sequence !== undefined) out["sequence_number"] = asInt(sequence);

  const withError = (error: Json): JsonObject => {
    let node: JsonObject;

    if (isJsonObject(error)) node = { ...error };
    else {
      const scalar = typeof error === "string" ? error : "";

      if (scalar.trim() !== "") {
        out["error"] = { message: scalar };

        return out;
      }

      node = {};
    }

    if (asString(node["message"]).trim() === "") {
      const code = asString(node["code"]).trim();
      const type = asString(node["type"]).trim();

      if (code !== "") node["message"] = codexPolicyFallbackMessage(code);
      else if (type !== "") node["message"] = type;
      else node["message"] = statusText(status);
    }

    out["error"] = node;

    return out;
  };

  const body = get(event, "body");

  if (body !== undefined) {
    out["body"] = body;
    const bodyError = get(body, "error");

    if (bodyError !== undefined && bodyError !== null) return withError(bodyError);
  }

  for (const path of ["error", "response.error"]) {
    const error = get(event, path);

    if (error !== undefined && error !== null) return withError(error);
  }

  const topLevel = get(codexTopLevelErrorBody(event), "error");

  if (topLevel !== undefined) return withError(topLevel);

  out["error"] = { type: "server_error", message: statusText(status) };

  return out;
};

const STATUS_PATHS = [
  "body.status",
  "body.status_code",
  "error.status",
  "error.status_code",
  "body.error.status",
  "body.error.status_code",
  "response.error.status",
  "response.error.status_code",
] as const;

/** `codexWebsocketErrorStatus`: the frame's own status, then an HTTP error status nested in its error (Go 5a373ede). */
const websocketErrorStatus = (event: Json | undefined): number => {
  for (const path of ["status", "status_code"]) {
    const status = asInt(get(event, path));

    if (status > 0) return status;
  }

  for (const path of STATUS_PATHS) {
    const status = asInt(get(event, path));

    if (status >= 400 && status <= 599) return status;
  }

  return 0;
};

/**
 * `inferCodexWebsocketErrorStatus` (Go 7dd360d9): the status a status-less error frame that carries headers stands for,
 * read from its error the way an HTTP failure would be classified.
 */
const inferWebsocketErrorStatus = (event: Json | undefined): number => {
  if (isConnectionLimitError(event)) return 429;
  const body = codexTerminalFailureBody(event);

  if (body === undefined) return 0;
  const text = JSON.stringify(body);

  if (isCodexUsageLimitError(text) || isCodexTransientCapacityError(text)) return 429;

  if (codexErrorIsContextLength(body)) return 400;
  const classification = codexStatusErrorClassification(400, text);

  if (classification !== undefined) return classification.code === "auth_unavailable" ? 401 : 400;
  const type = asString(get(body, "error.type")).trim().toLowerCase();
  const code = asString(get(body, "error.code")).trim().toLowerCase();

  if (type === "service_unavailable_error" || code === "server_is_overloaded") return 503;

  return codexTerminalFailureStatus(body);
};

/**
 * `parseCodexWebsocketErrorWithCooling`: an `error` frame (an untyped error envelope counts) with a positive status, its
 * own or nested; a frame without one that carries headers gets the status its error implies. A connection-limit error
 * retries immediately (`retryAfterMs` 0) on another credential.
 */
export const parseCodexWebsocketError = (
  event: Json | undefined,
  options: { readonly modelLevelCooling: boolean; readonly nowMs: number },
): { readonly error: ExecutionError; readonly body: string } | undefined => {
  if (codexResponseEventType(event) !== "error") return undefined;
  const headers = codexErrorEventHeaders(event);
  let status = websocketErrorStatus(event);

  if (status <= 0 && headers !== undefined) status = inferWebsocketErrorStatus(event);

  if (status <= 0) return undefined;
  const body = JSON.stringify(websocketErrorBody(event, status));
  const usageLimit = isCodexUsageLimitError(body);
  let retryAfterMs = parseCodexRetryAfterMs(status, body, options.nowMs);

  if (retryAfterMs === undefined && isConnectionLimitError(event)) retryAfterMs = 0;

  // Hint precedence: the quota body reset, then the connection-limit immediate retry, then the generic `Retry-After`
  // header of the frame (CLIProxyAPI 9a35fa12), on every status that honours one (7dd360d9).
  if (retryAfterMs === undefined && shouldParseCodexRetryAfterHeader(status))
    retryAfterMs = parseRetryAfterMs(headers?.["retry-after"] ?? null, options.nowMs);
  const transient = !usageLimit && status === 429 && isCodexTransientCapacityError(body);

  return {
    body,
    error: new ExecutionError({
      status,
      message: body,
      ...(transient ? { code: ErrorCode.transientRateLimit } : {}),
      ...(usageLimit && !options.modelLevelCooling ? { credentialScoped: true } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(headers !== undefined ? { headers } : {}),
    }),
  };
};

export interface CodexWebsocketDeps {
  readonly prepare: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly compact: boolean; readonly websocket: boolean },
  ) => Effect.Effect<PreparedRequest, ExecutionError, Thinking>;
  readonly replayStore: CodexReplayStore;
  /** `sdktranslator.TranslateNonStream` of the completed response (`undefined` = translation failure). */
  readonly translateNonStream?: (
    prepared: PreparedRequest,
    request: ExecutorRequest,
    completed: Json,
  ) => string | undefined;
  readonly store?: UpstreamSessionStore;
}

/** The upstream socket request of a prepared turn (`ensureUpstreamConn` target, handshake headers, first frame). */
const turnInputOf = (
  deps: CodexWebsocketDeps,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  prepared: PreparedRequest,
) => {
  const websocket = options.metadata.websocket;
  const modelLevelCooling = context.config.upstream.codex["model-level-cooling"];
  const url = websocketUrl(`${codexBaseUrl(context.credential)}/responses`);

  const frame = frameCodexWebsocketBody(prepared.body);

  return (dialedAt: number): OpenTurnInput => ({
    store: deps.store ?? codexSessionStore,
    sessionId: websocket?.sessionId,
    authId: context.credential.id,
    url,
    headers: prepared.headers,
    frame: () => frame,
    requireUpstream: websocket?.requireUpstream === true,
    label: "codex",
    classifyHandshake: (status, body, responseHeaders) =>
      // A 426 means the endpoint has no WebSocket support: surfaced as is (Go falls back to HTTP only when the client is
      // not a WebSocket, which cannot be the case here).
      status === 426
        ? new ExecutionError({ status, message: body })
        : newCodexStatusError(status, body, {
            modelLevelCooling,
            nowMs: dialedAt,
            headers: responseHeaders,
          }),
  });
};

/** The Go `CodexWebsocketsExecutor.ExecuteStream` path. */
export const makeCodexWebsocketStream =
  (deps: CodexWebsocketDeps) =>
  (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<Thinking>();

      const prepared = yield* deps.prepare(context, request, options, {
        stream: true,
        compact: false,
        websocket: true,
      });

      const websocket = options.metadata.websocket;
      const modelLevelCooling = context.config.upstream.codex["model-level-cooling"];
      const turnInput = turnInputOf(deps, context, request, options, prepared);

      const chunks = Stream.unwrap(
        Effect.gen(function* () {
          const turn = yield* openTurn(turnInput(yield* Clock.currentTimeMillis));
          context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);

          // `upstream.codex.response-steering`: the executor owns the socket until the downstream one goes away.
          // An `is-compat` endpoint does not speak `response.steer`, and a duplex stream would send its `compaction_trigger`
          // frames upstream instead of compacting them locally.
          if (
            websocket?.duplex !== undefined &&
            context.config.upstream.codex["response-steering"] &&
            !isCompatModel(context, request)
          ) {
            // The handler no longer infers this from the credential: it reads what the executor did.
            if (websocket.report !== undefined) websocket.report.duplex = true;

            return yield* startCodexDuplex({
              prepare: deps.prepare,
              replayStore: deps.replayStore,
              context,
              request,
              options,
              duplex: websocket.duplex,
              turn,
              initial: prepared,
              modelLevelCooling,
              frame: frameCodexWebsocketBody,
              parseWebsocketError: parseCodexWebsocketError,
            }).pipe(
              // The writer fiber prepares follow-up creates, which needs the request's services.
              Effect.provideContext(services),
              Effect.map((chunks) =>
                chunks.pipe(
                  Stream.tapError((error) =>
                    Effect.sync(() => context.usage.fail(error.status, error.message)),
                  ),
                ),
              ),
            );
          }

          const collector = new OutputItemCollector();
          let sawOutputDelta = false;

          const fail = (error: ExecutionError) =>
            turn.invalidate.pipe(
              Effect.andThen(() =>
                isThinkingSignatureInvalid(error.status, error.message) ? clearReplay : Effect.void,
              ),
              Effect.andThen(Effect.fail(error)),
            );

          const clearReplay = deps.replayStore.clear(
            prepared.replayScope.modelName,
            prepared.replayScope.sessionKey,
          );

          /** Observes one upstream message (usage, output items, replay cache) and classifies it. */
          const classify = (text: string) =>
            Effect.gen(function* () {
              const nowMs = yield* Clock.currentTimeMillis;

              const event = tryParseJson(
                restoreCodexMultiAgentV2Response(text, prepared.multiAgentV2),
              );

              context.usage.observeResponseModel(responseModelOf(event));

              if (!context.usage.ttftObserved)
                context.usage.observeTokenEvent(nowMs, isResponsesTokenEvent(text));

              const wsError = parseCodexWebsocketError(event, { modelLevelCooling, nowMs });

              if (wsError !== undefined) {
                return Outcome.failure({
                  error: wsError.error,
                  kind: "ws",
                  body: wsError.body,
                  overload: false,
                });
              }

              const failure = codexTerminalFailure(event, { modelLevelCooling, nowMs });

              if (failure !== undefined) {
                return Outcome.failure({
                  error: failure.error,
                  kind: "terminal",
                  body: failure.body,
                  overload: isOverloadBootstrapFailure(failure.body),
                });
              }

              if (hasMeaningfulOutputDelta(event)) sawOutputDelta = true;

              if (isTerminalEmptyIncomplete(event, collector.count, sawOutputDelta)) {
                return Outcome.failure({
                  error: codexEmptyIncompleteStreamError(),
                  kind: "empty",
                  body: "",
                  overload: false,
                });
              }

              const type = asString(get(event, "type"));

              if (type === "response.output_item.done") collector.collect(event);

              if (
                (type === "response.completed" ||
                  type === "response.done" ||
                  type === "response.incomplete") &&
                isJsonObject(event)
              ) {
                const completed = normalizeCodexCompletion(event);

                if (!prepared.nativeOutput) patchCodexCompletedOutput(completed, collector);

                if (type !== "response.incomplete")
                  yield* cacheReplayFromCompleted(
                    deps.replayStore,
                    prepared.replayScope,
                    completed,
                  );
                const detail = parseCodexUsage(completed);

                if (detail !== undefined) context.usage.publish(detail);
                const out = ensureResponsesUsageDetails(JSON.stringify(completed));

                return Outcome.frame({
                  chunks: [out],
                  terminal: true,
                  bufferable: false,
                  bytes: text.length + out.length,
                });
              }

              const out = text.includes('"usage"') ? ensureResponsesUsageDetails(text) : text;

              return Outcome.frame({
                chunks: [out],
                terminal: false,
                bufferable: isBootstrapBufferableEvent(type, text, event),
                bytes: text.length + out.length,
              });
            });

          const page = Effect.gen(function* () {
            const outcome = yield* classify(yield* turn.read);

            if (Outcome.$is("failure")(outcome)) return yield* fail(outcome.error);

            if (outcome.terminal) turn.complete();

            return [
              outcome.chunks,
              outcome.terminal ? Option.none<void>() : Option.some<void>(undefined),
            ] as const;
          });

          const firstPage: void = undefined;
          const streaming = Stream.paginate(firstPage, () => page);

          // `stream-bootstrap-buffering`: hold handshake frames until the first real event so an overload rejection
          // can fail the attempt over to another credential before anything reaches the client.
          const bootstrap = context.config.upstream.codex["stream-bootstrap-buffering"];

          const timeoutMs = bootstrapTimeoutMs(
            context.config.upstream.codex["stream-bootstrap-timeout"],
          );

          const buffered = bootstrap
            ? Effect.gen(function* () {
                const startedAt = yield* Clock.currentTimeMillis;
                const held: string[] = [];
                let frames = 0;
                let bytes = 0;

                while (true) {
                  const text = yield* turn.read;
                  // Every message read spends the frame budget, including the ones that are skipped.
                  frames += 1;
                  const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
                  const timeoutReached = timeoutMs > 0 && elapsed >= timeoutMs;
                  const windowOpen = frames <= BOOTSTRAP_MAX_BUFFERED_FRAMES && !timeoutReached;

                  if (text.trim() === "") {
                    if (!windowOpen) return { held, rest: streaming };
                    continue;
                  }

                  const outcome = yield* classify(text);

                  if (Outcome.$is("failure")(outcome)) {
                    if (outcome.overload && !timeoutReached) {
                      return yield* fail(
                        bootstrapOverloadError(
                          outcome.body,
                          yield* Clock.currentTimeMillis,
                          outcome.error,
                        ),
                      );
                    }

                    // An `error` frame, or a terminal usage limit (CLIProxyAPI 86a1aabf): the credential is out of quota,
                    // another one may serve the request, and nothing has reached the client yet.
                    const usageLimit =
                      outcome.kind === "terminal" && isCodexUsageLimitError(outcome.body);

                    if ((outcome.kind === "ws" || usageLimit) && !timeoutReached)
                      return yield* fail(outcome.error);
                    // Delivered in-stream after the held handshake.
                    yield* turn.invalidate;

                    if (isThinkingSignatureInvalid(outcome.error.status, outcome.error.message))
                      yield* clearReplay;

                    return { held, rest: Stream.fail(outcome.error) };
                  }

                  if (
                    windowOpen &&
                    outcome.bufferable &&
                    !outcome.terminal &&
                    bytes + outcome.bytes <= BOOTSTRAP_MAX_BUFFERED_BYTES
                  ) {
                    bytes += outcome.bytes;
                    held.push(...outcome.chunks);
                    continue;
                  }

                  if (outcome.terminal) turn.complete();

                  return {
                    held: [...held, ...outcome.chunks],
                    rest: outcome.terminal ? Stream.empty : streaming,
                  };
                }
              })
            : Effect.succeed({ held: Array.of<string>(), rest: streaming });

          const { held, rest } = yield* buffered;

          return Stream.concat(Stream.fromIterable(held), rest).pipe(
            Stream.tapError((error) =>
              Effect.sync(() => context.usage.fail(error.status, error.message)),
            ),
          );
        }),
      );

      return { headers: new Headers(), chunks } satisfies StreamResult;
    });

/**
 * The Go `CodexWebsocketsExecutor.Execute` path (non-stream request of a downstream WebSocket): the same upstream socket
 * and session rules as the stream, reading events until the first terminal one and answering with the translated
 * completed response.
 */
export const makeCodexWebsocketExecute =
  (deps: CodexWebsocketDeps) =>
  (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* deps.prepare(context, request, options, {
          stream: false,
          compact: false,
          websocket: true,
        });

        const modelLevelCooling = context.config.upstream.codex["model-level-cooling"];

        const turn = yield* openTurn(
          turnInputOf(deps, context, request, options, prepared)(yield* Clock.currentTimeMillis),
        );

        context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);

        const clearReplay = deps.replayStore.clear(
          prepared.replayScope.modelName,
          prepared.replayScope.sessionKey,
        );

        const fail = (error: ExecutionError) =>
          turn.invalidate.pipe(
            Effect.andThen(() =>
              isThinkingSignatureInvalid(error.status, error.message) ? clearReplay : Effect.void,
            ),
            Effect.andThen(Effect.fail(error)),
          );

        const collector = new OutputItemCollector();
        let sawOutputDelta = false;

        while (true) {
          const text = yield* turn.read;
          const nowMs = yield* Clock.currentTimeMillis;
          const event = tryParseJson(restoreCodexMultiAgentV2Response(text, prepared.multiAgentV2));
          context.usage.observeResponseModel(responseModelOf(event));

          if (!context.usage.ttftObserved)
            context.usage.observeTokenEvent(nowMs, isResponsesTokenEvent(text));

          const wsError = parseCodexWebsocketError(event, { modelLevelCooling, nowMs });

          if (wsError !== undefined) return yield* fail(wsError.error);
          const failure = codexTerminalFailure(event, { modelLevelCooling, nowMs });

          if (failure !== undefined) return yield* fail(failure.error);

          if (hasMeaningfulOutputDelta(event)) sawOutputDelta = true;
          const type = asString(get(event, "type"));

          if (type === "response.output_item.done") collector.collect(event);

          if (
            (type !== "response.completed" &&
              type !== "response.done" &&
              type !== "response.incomplete") ||
            !isJsonObject(event)
          ) {
            continue;
          }

          const completed = normalizeCodexCompletion(event);

          if (isTerminalEmptyIncomplete(completed, collector.count, sawOutputDelta)) {
            return yield* fail(codexEmptyIncompleteStreamError());
          }

          patchCodexCompletedOutput(completed, collector);

          if (type !== "response.incomplete")
            yield* cacheReplayFromCompleted(deps.replayStore, prepared.replayScope, completed);
          const detail = parseCodexUsage(completed);

          if (detail !== undefined) context.usage.publish(detail);

          const translated =
            deps.translateNonStream?.(prepared, request, completed) ?? JSON.stringify(completed);

          if (translated === "")
            return yield* fail(
              new ExecutionError({ status: 502, message: "response translation failed" }),
            );
          turn.complete();

          const payload =
            prepared.responseFormat === "openai-response"
              ? ensureResponsesUsageDetails(translated)
              : translated;

          return { payload, headers: turn.headers } satisfies ExecutorResponse;
        }
      }),
    );

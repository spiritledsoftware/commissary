/**
 * The Responses WebSocket session loop: reads client frames, plans each turn, runs it through the conductor
 * (`executeStream`, WebSocket passthrough or HTTP fallback) and forwards the events as WebSocket text frames.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket.go (ResponsesWebsocket, responsesWebsocketWriter),
 * openai_responses_websocket_forward.go (forwardResponsesWebsocket, writeResponsesWebsocketTerminalError),
 * openai_responses_websocket_input.go (readResponsesWebsocketInput, responsesLocalInterrupt,
 * forwardResponsesWebsocketInterrupt), openai_responses_websocket_prewarm.go (writeResponsesWebsocketSyntheticPrewarm).
 *
 * The loop runs as one fiber for the lifetime of the socket; a second fiber is the only reader of the client socket so
 * a `response.interrupt` reaches the running turn immediately. Every turn runs in its own scope: closing the client socket
 * interrupts the fiber, which closes the attempt (reported as a connection-lifecycle failure, no cooldown) and the
 * upstream execution sessions of the socket.
 *
 * Deviations from Go: no WebSocket ping keep-alives (the Workers WebSocket API cannot send ping frames; events and the
 * upstream idle deadline keep the socket busy); terminal failures close with 1011/1012/1009 instead of dropping the TCP
 * connection; request logs/timelines are not written.
 */
import {
  type Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Option,
  Pull,
  Queue,
  Result,
  type Scope,
  Stream,
} from "effect";
import { ExecutionError } from "../../../executor/errors.ts";
import { isCodexResponsesLiteRequest } from "../../../executor/codex/headers.ts";
import { codexWebsocketsEnabled } from "../../../executor/codex/websocket.ts";
import type { WebsocketDuplex } from "../../../executor/types.ts";
import type { CredentialSnapshot } from "../../../executor/picker.ts";
import { codexSessionStore, xaiSessionStore } from "../../../executor/websocket/session.ts";
import { xaiIdStates } from "../../../executor/xai/websocket-ids.ts";
import { asString, get, isJsonObject, type JsonObject, tryParseJson } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import type { ExecutionInput, StreamOutput } from "../../execute.ts";
import {
  buildErrorPayload,
  closeForUpstreamError,
  errorFromPayload,
  isCompletionEvent,
  OutputCollector,
  payloadsFromChunk,
  shouldExposeError,
  truncateCloseReason,
} from "./frames.ts";
import { isCodexResponsesClient, isPrivateResponsesEvent } from "../framer.ts";
import { syntheticPrewarmPayloads } from "./normalize.ts";
import {
  commitPrewarm,
  commitTurn,
  isWebsocketProvider,
  newSocketState,
  planTurn,
  Plan,
  type SocketState,
} from "./plan.ts";
import {
  type ToolCaches,
  type ToolCacheTurn,
  prepareFallbackTurn,
  recordToolCallsFromPayload,
} from "./tool-cache.ts";

/** Go close code for terminal failures without a mirrored code (the TCP connection is simply dropped there). */
const CLOSE_INTERNAL_ERROR = 1011;

export interface SocketIO {
  readonly send: (text: string) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface SocketDeps<R> {
  readonly io: SocketIO;
  /** Id of the socket: the execution session of its upstream sockets. */
  readonly sessionId: string;
  /** Inbound request headers (`x-codex-*` lite detection). */
  readonly headers: Headers;
  /** Tool-cache session key (`downstreamSessionKey`); empty disables repair. */
  readonly toolSessionKey: string;
  readonly toolCaches: ToolCaches;
  /** Prepares the planned request for Codex clients (multi-agent v2 tools, orphan delegations). */
  readonly prepare?: (payload: JsonObject) => Effect.Effect<void, never, R>;
  /**
   * `upstream.codex.response-steering`: Codex credentials with upstream WebSockets get the client frames and run the socket
   * full duplex (`executor/codex/duplex.ts`).
   */
  readonly steering?: boolean;
  /** Whether a credential may still carry traffic (Go `WithWebsocketAuthCheck`); defaults to true. */
  readonly authEnabled?: (credentialId: string) => boolean;
  /** Runs one turn through the conductor. */
  readonly execute: (
    input: Omit<ExecutionInput, "request">,
  ) => Effect.Effect<StreamOutput, ExecutionError, R | Scope.Scope>;
  /** Wall clock (injectable for tests). */
  readonly now?: () => { readonly id: string; readonly createdAt: number };
}

class ForwardStop extends Data.TaggedError("ForwardStop")<{
  readonly error: ExecutionError;
  /** The error event as received (forwarded to the client as is when it is exposed). */
  readonly payload?: JsonObject;
}> {}

interface ForwardResult {
  /** The duplex stream ended with its socket (the downstream side is gone or closing). */
  readonly duplexClosed?: boolean;
  readonly error: ExecutionError | undefined;
  readonly payload: JsonObject | undefined;
  readonly completedOutput: ReadonlyArray<ReturnType<OutputCollector["completedOutput"]>[number]>;
  readonly completedResponseId: string;
  readonly pendingToolCallIds: string[];
}

const takeOption = <A>(queue: Queue.Dequeue<A, Cause.Done>) =>
  Queue.take(queue).pipe(
    Effect.map(Option.some),
    Pull.catchDone(() => Effect.succeed(Option.none<A>())),
  );

/**
 * Runs the socket until the client closes (the commands queue ends) or a terminal failure closes it. `raw` receives every
 * client frame and ends when the client socket closes.
 */
export const runResponsesSocket = <R>(
  deps: SocketDeps<R>,
  raw: Queue.Dequeue<string, Cause.Done>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { io, sessionId } = deps;
      const state: SocketState = newSocketState();
      const codexClient = isCodexResponsesClient(deps.headers);
      const commands = yield* Queue.bounded<string, Cause.Done>(16);
      let interruptSignal: Deferred.Deferred<string> | undefined;
      let closed = false;
      let hasTurnInFlight = false;
      // The selected credential's executor owns the socket (Codex response steering): a response ends no stream.
      let duplexStream = false;

      const duplexInput: WebsocketDuplex | undefined =
        deps.steering === true
          ? {
              next: takeOption(commands).pipe(
                Effect.map((next) => (Option.isSome(next) ? next.value : undefined)),
              ),
              ...(deps.authEnabled !== undefined ? { authEnabled: deps.authEnabled } : {}),
            }
          : undefined;

      const write = (payload: JsonObject): void => {
        if (!closed) io.send(JSON.stringify(payload));
      };

      const closeSocket = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        io.close(code, truncateCloseReason(reason));
      };

      /** `closeForUpstreamError` + `writeResponsesWebsocketTerminalError`: mirror, expose or just close. */
      const terminate = (error: ExecutionError, payload?: JsonObject): void => {
        const mirrored = closeForUpstreamError(error);

        if (mirrored !== undefined) return closeSocket(mirrored.code, mirrored.reason);

        if (shouldExposeError(error)) write(payload ?? buildErrorPayload(error));
        closeSocket(CLOSE_INTERNAL_ERROR, shouldExposeError(error) ? "error" : "upstream error");
      };

      // The upstream socket of the session dropped while no request was running: close like Go does.
      const unsubscribe = [codexSessionStore, xaiSessionStore].map((store) =>
        store.onDisconnect(sessionId, (error) => {
          // Only the selected credential's duplex stream owns closure: it drains acknowledgements and pending events in order.
          if (store === codexSessionStore && duplexStream) return;
          terminate(error);
        }),
      );

      deps.toolCaches.retain(deps.toolSessionKey);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;

          for (const stop of unsubscribe) stop();
          deps.toolCaches.release(deps.toolSessionKey);
          xaiIdStates.delete(sessionId);
          yield* codexSessionStore.close(sessionId, "downstream_closed");
          yield* xaiSessionStore.close(sessionId, "downstream_closed");
        }),
      );

      // --- client frame reader: the only consumer of `raw`, so interrupts never wait behind a running response -----
      const interrupt = Effect.fnUntraced(function* (frame: JsonObject, text: string) {
        const responseId = frame["response_id"];

        if (typeof responseId !== "string" || responseId.trim() === "") {
          write(
            buildErrorPayload({ status: 400, message: "response.interrupt requires response_id" }),
          );

          return;
        }

        if (yield* codexSessionStore.interrupt(sessionId, text)) return;
        const signal = interruptSignal;

        if (hasTurnInFlight && signal !== undefined) {
          yield* Deferred.succeed(signal, responseId.trim());

          return;
        }

        write(buildErrorPayload({ status: 400, message: "no active upstream websocket" }));
      });

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const next = yield* takeOption(raw);

            if (Option.isNone(next)) return yield* Queue.end(commands);
            const frame = tryParseJson(next.value);

            if (isJsonObject(frame) && asString(frame["type"]) === "response.interrupt") {
              yield* interrupt(frame, next.value);
              continue;
            }

            yield* Queue.offer(commands, next.value);
          }
        }),
      );

      // --- one turn ----------------------------------------------------------------------------------------------
      const forward = Effect.fnUntraced(function* (
        chunks: Stream.Stream<string, ExecutionError>,
        options: {
          readonly toolTurn: ToolCacheTurn | undefined;
          readonly preserveCompletionOutput: () => boolean;
          readonly signal: Deferred.Deferred<string>;
        },
      ) {
        const collector = new OutputCollector();
        let completed = false;
        let responseStarted = false;
        let completedOutput: ForwardResult["completedOutput"] = [];
        let completedResponseId = "";

        const consume = chunks.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              for (const payload of payloadsFromChunk(chunk)) {
                const type = asString(payload["type"]);

                // Moderation metadata is private to Codex clients (CLIProxyAPI ae65e26d).
                if (type === "response.metadata" && isPrivateResponsesEvent(type, codexClient))
                  continue;

                if (type === "response.created") {
                  responseStarted = true;
                  collector.reset();
                  completed = false;
                }

                collector.collect(payload);

                if (isCompletionEvent(type) && !options.preserveCompletionOutput())
                  collector.restoreCompletionOutput(payload);

                if (options.toolTurn !== undefined) options.toolTurn.recordResponse(payload);
                else recordToolCallsFromPayload(deps.toolCaches, deps.toolSessionKey, payload);
                collector.recordPending(payload);
                // In Codex duplex mode the executor owns connection termination: payload errors after response.created are
                // recoverable events; a failing stream still arrives as an execution error and closes the socket.
                const preserveErrorEvent = responseStarted && duplexStream;

                if (type === "error" && !preserveErrorEvent) {
                  const stop = new ForwardStop({ error: errorFromPayload(payload), payload });

                  return yield* Effect.fail(stop);
                }

                if (
                  type !== "error" &&
                  (isCompletionEvent(type) || type === "response.incomplete")
                ) {
                  completed = true;
                  completedOutput = collector.completedOutput(payload);
                  completedResponseId = asString(get(payload, "response.id")).trim();
                }

                write(payload);
              }
            }),
          ),
          Effect.mapError((error): ForwardStop =>
            error instanceof ExecutionError ? new ForwardStop({ error }) : error,
          ),
        );

        const result: Effect.Effect<"done" | "interrupted", ForwardStop> = Effect.raceFirst(
          consume.pipe(Effect.as("done" as const)),
          Deferred.await(options.signal).pipe(
            Effect.tap((responseId) =>
              Effect.sync(() => {
                // The interrupted response is acknowledged like a completed one so the client can continue.
                const payload = collector.interruptedPayload(responseId);
                completedOutput = collector.completedOutput(payload);
                completedResponseId = responseId;
                write(payload);
              }),
            ),
            Effect.as("interrupted" as const),
          ),
        );

        const outcome = yield* Effect.result(result);

        if (Result.isFailure(outcome)) {
          const failure = outcome.failure;

          return {
            error: failure.error,
            payload: failure.payload,
            completedOutput,
            completedResponseId,
            pendingToolCallIds: collector.pending(),
          } satisfies ForwardResult;
        }

        if (outcome.success === "done" && duplexStream) {
          // A duplex stream ends with its socket, not with an individual response.
          return {
            duplexClosed: true,
            error: undefined,
            payload: undefined,
            completedOutput,
            completedResponseId,
            pendingToolCallIds: collector.pending(),
          } satisfies ForwardResult;
        }

        if (outcome.success === "done" && !completed) {
          return {
            error: new ExecutionError({
              status: 408,
              message: "stream closed before response.completed",
            }),
            payload: undefined,
            completedOutput,
            completedResponseId,
            pendingToolCallIds: collector.pending(),
          } satisfies ForwardResult;
        }

        return {
          error: undefined,
          payload: undefined,
          completedOutput,
          completedResponseId,
          pendingToolCallIds: collector.pending(),
        } satisfies ForwardResult;
      });

      const executeTurn = Effect.fnUntraced(function* (plan: Extract<Plan, { _tag: "execute" }>) {
        const { request: planned, nativePassthrough } = plan;

        // Native passthrough keeps the state upstream; otherwise tool calls are repaired against the session caches.
        const repaired = nativePassthrough
          ? { request: planned, turn: undefined }
          : prepareFallbackTurn(deps.toolCaches, deps.toolSessionKey, planned);

        const requestJson = repaired.request;

        if (nativePassthrough && plan.modelName !== "") state.passthroughModelName = plan.modelName;
        const nativeRequest = isCodexResponsesLiteRequest(requestJson, deps.headers);
        let selected: CredentialSnapshot | undefined;
        let pinnedAuthAttempted = false;
        const pinnedId = plan.pinnedId;
        const signal = yield* Deferred.make<string>();
        interruptSignal = signal;
        hasTurnInFlight = true;
        duplexStream = false;

        const replayPinnedAuthFailure = (error: ExecutionError): boolean =>
          nativePassthrough &&
          plan.requiresCurrentUpstream &&
          pinnedAuthAttempted &&
          (error.status === 401 || error.status === 429);

        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Effect.result(
              deps.execute({
                entryProtocol: Formats.OpenAIResponse,
                model: plan.modelName,
                body: requestJson,
                alt: "",
                websocket: {
                  sessionId,
                  requireUpstream: plan.requiresCurrentUpstream,
                  ...(duplexInput !== undefined ? { duplex: duplexInput } : {}),
                },
                ...(pinnedId !== "" ? { pinnedId } : {}),
                onSelected: (credential) => {
                  selected = credential;
                  duplexStream =
                    deps.steering === true &&
                    credential.provider === "codex" &&
                    codexWebsocketsEnabled(credential);

                  if (pinnedId !== "" && credential.id === pinnedId) pinnedAuthAttempted = true;
                },
              }),
            );

            if (Result.isFailure(started)) {
              return {
                error: started.failure,
                payload: undefined,
                completedOutput: [],
                completedResponseId: "",
                pendingToolCallIds: [],
              } satisfies ForwardResult;
            }

            return yield* forward(started.success.chunks, {
              toolTurn: repaired.turn,
              preserveCompletionOutput: () => nativeRequest && selected?.provider === "codex",
              signal,
            });
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              hasTurnInFlight = false;
              interruptSignal = undefined;
            }),
          ),
        );

        if (result.duplexClosed === true) {
          closeSocket(1000, "");

          return true;
        }

        if (result.error !== undefined) {
          // A continuation cannot rotate credentials in place: the client replays the whole turn on a new socket.
          if (replayPinnedAuthFailure(result.error)) {
            closeSocket(1012, "upstream requires HTTP replay");
          } else terminate(result.error, result.payload);

          return true;
        }

        repaired.turn?.commit();
        commitTurn(state, {
          modelName: plan.modelName,
          executedRequest: nativePassthrough ? state.lastRequest : requestJson,
          selected:
            selected === undefined
              ? undefined
              : {
                  authId: selected.id,
                  provider: selected.provider,
                  websockets:
                    isWebsocketProvider(selected.provider) && codexWebsocketsEnabled(selected),
                },
          completedOutput: [...result.completedOutput],
          completedResponseId: result.completedResponseId,
          pendingToolCallIds: result.pendingToolCallIds,
        });

        return false;
      });

      // --- main loop -----------------------------------------------------------------------------------------------
      while (true) {
        if (closed) return;
        const next = yield* takeOption(commands);

        if (Option.isNone(next)) return;
        const parsed = tryParseJson(next.value);
        const payload: JsonObject = isJsonObject(parsed) ? parsed : {};
        const plan = planTurn(state, payload);

        // Go prepares the normalised request (after the transcript was rebuilt), not the raw frame.
        if (
          deps.prepare !== undefined &&
          (Plan.$is("execute")(plan) || Plan.$is("prewarm")(plan))
        ) {
          yield* deps.prepare(plan.request);
        }

        if (Plan.$is("error")(plan)) {
          write(buildErrorPayload(plan.error));
        } else if (Plan.$is("replay")(plan)) {
          closeSocket(1012, "upstream requires HTTP replay");
        } else if (Plan.$is("prewarm")(plan)) {
          const now = deps.now?.() ?? {
            id: crypto.randomUUID(),
            createdAt: Math.floor((yield* Clock.currentTimeMillis) / 1000),
          };

          const [created, completed] = syntheticPrewarmPayloads(plan.request, now);
          write(created);
          write(completed);
          commitPrewarm(state, plan, asString(get(created, "response.id")));
        } else if (yield* executeTurn(plan)) {
          return;
        }
      }
    }),
  );

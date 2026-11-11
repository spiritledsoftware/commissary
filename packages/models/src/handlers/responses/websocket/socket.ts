/**
 * The Responses WebSocket session loop: reads client frames, plans each turn, runs it through the conductor
 * (`executeStream`, WebSocket passthrough or HTTP fallback) and forwards the events as WebSocket text frames.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket.go (ResponsesWebsocket, responsesWebsocketWriter),
 * openai_responses_websocket_forward.go (forwardResponsesWebsocket, writeResponsesWebsocketTerminalError),
 * openai_responses_websocket_input.go (readResponsesWebsocketInput, responsesLocalInterrupt,
 * forwardResponsesWebsocketInterrupt), openai_responses_websocket_prewarm.go (writeResponsesWebsocketSyntheticPrewarm);
 * f73e66ac (the client socket outlives its upstream socket: input epoch, loss frames), b5e6027c (pinned 429, exposed
 * quota frames), 9717e325 and d318bcc3 (late interrupts).
 *
 * The loop runs as one fiber for the lifetime of the socket; a second fiber is the only reader of the client socket so
 * a `response.interrupt` reaches the running turn immediately. Every turn runs in its own scope: closing the client socket
 * interrupts the fiber, which closes the attempt (reported as a connection-lifecycle failure, no cooldown) and the
 * upstream execution sessions of the socket.
 *
 * A request is one exchange on the socket. An upstream socket loss (`upstream_websocket_lost`) never closes the client
 * socket: it is answered with a non-closing error frame, the input the client had already queued is fenced (an epoch
 * stamped by the reader fiber; a stale frame is answered "not sent" / 409 and never reaches upstream) and the pinned
 * credential is kept, so the client's next full create redials on it.
 *
 * Interrupts (`response.interrupt`) are decided here from state the loop already sees in one fiber: the running response
 * id, the ids of the last {@link FINISHED_IDS} finished responses (a late interrupt for one is dropped) and whether the
 * request runs on a Codex upstream socket (then the frame is forwarded upstream, never resolved locally).
 *
 * Deviations from Go: no WebSocket ping keep-alives (the Workers WebSocket API cannot send ping frames; events and the
 * upstream idle deadline keep the socket busy); terminal failures close with 1011/1012/1009 instead of dropping the TCP
 * connection; request logs/timelines are not written; the loss contract also covers xAI sockets; the finished ids are a
 * ring of {@link FINISHED_IDS} that also covers requests over HTTP and survives a redial; an interrupt for another id than
 * the running one of an HTTP request is a 400; Home failover is not ported.
 */
import {
  type Cause,
  Clock,
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
import type { WebsocketDuplex, WebsocketReport } from "../../../executor/types.ts";
import type { CredentialSnapshot } from "../../../executor/picker.ts";
import {
  type AbandonedOperation,
  abandonedOf,
  codexSessionStore,
  isUpstreamLost,
  isUpstreamTurnError,
  notSentError,
  previousResponseNotFoundError,
  upstreamLostError,
  xaiSessionStore,
} from "../../../executor/websocket/session.ts";
import { xaiIdStates } from "../../../executor/xai/websocket-ids.ts";
import { asString, get, isJsonObject, type JsonObject, tryParseJson } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import type { ExecutionInput, StreamOutput } from "../../execute.ts";
import {
  buildErrorPayload,
  closeForUpstreamError,
  errorFromPayload,
  isCompletionEvent,
  isQuotaOrCooldownError,
  OutputCollector,
  payloadsFromChunk,
  shouldExposeError,
  truncateCloseReason,
} from "./frames.ts";
import { isCodexResponsesClient, isPrivateResponsesEvent } from "../framer.ts";
import {
  inputContainsFullTranscript,
  stripReplayOutputOnlyFields,
  syntheticPrewarmPayloads,
} from "./normalize.ts";
import {
  commitLoss,
  commitPrewarm,
  commitTurn,
  isWebsocketProvider,
  localBoundaryRequest,
  newSocketState,
  planTurn,
  Plan,
  requiresCurrentUpstream,
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
  /**
   * Whether a credential other than `excludedId` could serve the request now (`hasAlternativeTarget`): asked after a
   * pinned continuation fails with a 429, to decide between a replay and an exposed error.
   */
  readonly hasAlternative: (
    input: Omit<ExecutionInput, "request">,
    excludedId: string,
  ) => Effect.Effect<boolean, never, R>;
  /** Wall clock (injectable for tests). */
  readonly now?: () => { readonly id: string; readonly createdAt: number };
}

/** Finished response ids remembered for `response.interrupt` (Go keeps an unbounded set per upstream connection). */
export const FINISHED_IDS = 64;

/** A client frame with the input epoch the reader fiber saw when it read it. */
interface Command {
  readonly text: string;
  readonly epoch: number;
}

interface ForwardResult {
  /** The duplex stream ended with its socket (the downstream side is gone or closing). */
  readonly duplexClosed?: boolean;
  readonly error: ExecutionError | undefined;
  /** The `error` event that stopped the forwarding, as received (exposed to the client as is). */
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

/** The terminal events of a response: its interrupt window closes before the client sees them. */
const isTerminalResponseEvent = (type: string): boolean =>
  isCompletionEvent(type) || type === "response.incomplete" || type === "response.failed";

const eventIdOf = (frame: JsonObject): string => asString(frame["event_id"]).trim();

/** What a client is told about an operation that lost its outcome with the running request. */
const abandonedError = (operation: AbandonedOperation): ExecutionError => {
  switch (operation.outcome) {
    case "not_sent":
      return notSentError();
    case "continuation":
      return previousResponseNotFoundError();
    case "lost":
      return upstreamLostError();
  }
};

/** `error.event_id`: ties an error frame to the client frame it answers. */
const withEventId = (frame: JsonObject, eventId: string): JsonObject => {
  const error = frame["error"];

  if (eventId !== "" && isJsonObject(error)) error["event_id"] = eventId;

  return frame;
};

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
      const commands = yield* Queue.bounded<Command, Cause.Done>(16);
      let interruptSignal: Deferred.Deferred<string> | undefined;
      let closed = false;
      let hasTurnInFlight = false;
      // How the current attempt ran, reported by its executor (reset when a credential is selected): the executor that
      // owns the socket (Codex response steering) ends no stream with a response, and one that answered without the
      // upstream socket (local compaction) leaves the socket in HTTP mode.
      let report: WebsocketReport = { local: false, duplex: false };
      const duplexStream = (): boolean => report.duplex;
      // Advanced by an upstream loss mid-request: frames read under an older epoch predate it and are never run.
      let epoch = 0;

      // --- interrupt state: all of it lives here, where `forward` sees the events (see the module header) ----------
      /** Id of the response that is running now (`response.created` .. its terminal event); empty between responses. */
      let runningId = "";
      /** The request has seen a `response.created`. */
      let responsesStarted = false;
      /** The request runs on a Codex upstream socket: `response.interrupt` is forwarded there, never resolved locally. */
      let upstreamRequest = false;
      /** A request over HTTP may still resolve an interrupt locally (closed by its terminal event). */
      let localOpen = false;
      const finished: string[] = [];

      const rememberFinished = (id: string): void => {
        const trimmed = id.trim();

        if (trimmed === "" || finished.includes(trimmed)) return;
        finished.push(trimmed);

        if (finished.length > FINISHED_IDS) finished.shift();
      };

      /** A response ended (terminal event, local interrupt, stopping error): remembered, and no interrupt can claim it. */
      const closeResponse = (id: string): void => {
        rememberFinished(id !== "" ? id : runningId);
        runningId = "";
        localOpen = false;
      };

      /**
       * The executor answers this request without the upstream socket (local compaction). Such a request is atomic: the
       * summary is one HTTP exchange and its response arrives whole, so there is nothing to interrupt, and cutting it
       * short would drop the compaction item the transcript boundary stands on. An interrupt is never forwarded upstream
       * either, even on a credential that owns an upstream socket.
       */
      const answeredLocally = (): boolean => report.local;

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

      /** `writeResponsesWebsocketPreviousResponseNotFound`: a frame read before an upstream loss is never run. */
      const answerStale = (text: string): void => {
        const parsed = tryParseJson(text);
        const frame: JsonObject = isJsonObject(parsed) ? parsed : {};

        write(
          withEventId(
            buildErrorPayload(
              requiresCurrentUpstream(frame) ? previousResponseNotFoundError() : notSentError(),
            ),
            eventIdOf(frame),
          ),
        );
      };

      /**
       * The hand-off of a client frame to whoever runs it: the main loop, or the steering executor through
       * `duplexInput.next`. The checks run in order, and a frame that fails one is answered here and never handed on:
       * first the stale-frame fence; per-request re-authorisation (B7) is the next check, after it.
       */
      const handOff: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
        while (true) {
          const next = yield* takeOption(commands);

          if (Option.isNone(next)) return Option.none<string>();

          if (next.value.epoch < epoch) {
            answerStale(next.value.text);
            continue;
          }

          return Option.some(next.value.text);
        }
      });

      const duplexInput: WebsocketDuplex | undefined =
        deps.steering === true
          ? {
              next: handOff.pipe(
                Effect.map((next) => (Option.isSome(next) ? next.value : undefined)),
              ),
              ...(deps.authEnabled !== undefined ? { authEnabled: deps.authEnabled } : {}),
            }
          : undefined;

      deps.toolCaches.retain(deps.toolSessionKey);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;

          deps.toolCaches.release(deps.toolSessionKey);
          xaiIdStates.delete(sessionId);
          yield* codexSessionStore.close(sessionId, "downstream_closed");
          yield* xaiSessionStore.close(sessionId, "downstream_closed");
        }),
      );

      // --- client frame reader: the only consumer of `raw`, so interrupts never wait behind a running response -----
      const rejectInterrupt = (message: string): void =>
        write(buildErrorPayload({ status: 400, message }));

      /** The error that says why no interrupt can reach an upstream socket: its loss, else that there is none. */
      const noUpstreamSocketMessage = (): string =>
        codexSessionStore.peek(sessionId)?.lost === true
          ? upstreamLostError().message
          : "no active upstream websocket";

      /**
       * `response.interrupt` (CLIProxyAPI 9717e325, d318bcc3). A request on a Codex upstream socket gets the frame
       * forwarded when it can only target the running response, and never the local path; a request over HTTP resolves
       * it locally while its response runs. An id that finished is dropped silently: the client lost a race.
       */
      const interrupt = Effect.fnUntraced(function* (frame: JsonObject, text: string) {
        const responseId = frame["response_id"];

        if (typeof responseId !== "string" || responseId.trim() === "") {
          rejectInterrupt("response.interrupt requires response_id");

          return;
        }

        const id = responseId.trim();

        if (finished.includes(id)) return;

        if (!hasTurnInFlight) return rejectInterrupt("no active upstream websocket");

        // The client lost a race with a response that cannot be cut short; it completes (like a finished id).
        if (answeredLocally()) return;

        if (upstreamRequest) {
          // Between responses of a steering socket, or while another response runs, the id targets nothing.
          if ((runningId !== "" && id !== runningId) || (runningId === "" && responsesStarted))
            return rejectInterrupt(
              "response.interrupt does not target the active upstream response",
            );

          // Before `response.created` the upstream validates the id.
          if (yield* codexSessionStore.interrupt(sessionId, text)) return;

          return rejectInterrupt(noUpstreamSocketMessage());
        }

        if (!localOpen) return rejectInterrupt("no active upstream websocket");

        if (runningId !== "" && id !== runningId)
          return rejectInterrupt("response.interrupt does not target the active response");
        const signal = interruptSignal;

        if (signal === undefined) return rejectInterrupt("no active upstream websocket");
        yield* Deferred.succeed(signal, id);
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

            yield* Queue.offer(commands, { text: next.value, epoch });
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
        // The `error` event that stops the forwarding: the attempt fails with its error (so the conductor classifies it
        // and cools the credential accordingly), the event itself is what an exposed error frame carries.
        let stopPayload: JsonObject | undefined;

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
                  responsesStarted = true;
                  runningId = asString(get(payload, "response.id")).trim();
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
                const preserveErrorEvent = responseStarted && duplexStream();

                if (type === "error" && !preserveErrorEvent) {
                  closeResponse("");
                  stopPayload = payload;

                  return yield* errorFromPayload(payload);
                }

                if (
                  type !== "error" &&
                  (isCompletionEvent(type) || type === "response.incomplete")
                ) {
                  completed = true;
                  completedOutput = collector.completedOutput(payload);
                  completedResponseId = asString(get(payload, "response.id")).trim();
                }

                // The response is over: no interrupt may claim it before the client can see its terminal event.
                if (isTerminalResponseEvent(type))
                  closeResponse(asString(get(payload, "response.id")));

                write(payload);
              }
            }),
          ),
        );

        const result: Effect.Effect<"done" | "interrupted", ExecutionError> = Effect.raceFirst(
          consume.pipe(Effect.as("done" as const)),
          Deferred.await(options.signal).pipe(
            Effect.tap((responseId) =>
              Effect.sync(() => {
                // The interrupted response is acknowledged like a completed one so the client can continue.
                const payload = collector.interruptedPayload(responseId);
                completedOutput = collector.completedOutput(payload);
                completedResponseId = responseId;
                closeResponse(responseId);
                write(payload);
              }),
            ),
            Effect.as("interrupted" as const),
          ),
        );

        const outcome = yield* Effect.result(result);

        if (Result.isFailure(outcome)) {
          return {
            error: outcome.failure,
            payload: stopPayload,
            completedOutput,
            completedResponseId,
            pendingToolCallIds: collector.pending(),
          } satisfies ForwardResult;
        }

        if (outcome.success === "done" && duplexStream()) {
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

      const executeTurn = Effect.fnUntraced(function* (
        plan: Extract<Plan, { _tag: "execute" }>,
        frame: JsonObject,
      ) {
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
        let lostWhileIdle = false;
        const pinnedId = plan.pinnedId;
        const startEpoch = epoch;
        const signal = yield* Deferred.make<string>();
        const attemptReport: WebsocketReport = { local: false, duplex: false };
        report = attemptReport;
        interruptSignal = signal;
        hasTurnInFlight = true;
        runningId = "";
        responsesStarted = false;
        // A pinned continuation runs on its Codex upstream socket; any other request resolves interrupts locally until
        // a credential that owns an upstream socket is selected.
        upstreamRequest = nativePassthrough && state.lastProvider === "codex";
        localOpen = !upstreamRequest;

        const input: Omit<ExecutionInput, "request"> = {
          entryProtocol: Formats.OpenAIResponse,
          model: plan.modelName,
          body: requestJson,
          alt: "",
          websocket: {
            sessionId,
            requireUpstream: plan.requiresCurrentUpstream,
            report: attemptReport,
            ...(duplexInput !== undefined ? { duplex: duplexInput } : {}),
          },
          ...(pinnedId !== "" ? { pinnedId } : {}),
          onSelected: (credential) => {
            selected = credential;
            attemptReport.local = false;
            attemptReport.duplex = false;
            upstreamRequest = credential.provider === "codex" && codexWebsocketsEnabled(credential);
            localOpen = !upstreamRequest && runningId === "" && !responsesStarted;

            if (pinnedId !== "" && credential.id === pinnedId) pinnedAuthAttempted = true;
          },
        };

        /**
         * A continuation cannot rotate credentials in place: the client replays the whole request on a new socket, unless
         * that would meet the same 429 (b5e6027c): the probe asks whether another credential could serve the replay.
         */
        const replayPinnedFailure = (error: ExecutionError) =>
          Effect.gen(function* () {
            if (!nativePassthrough || !plan.requiresCurrentUpstream || !pinnedAuthAttempted)
              return false;

            if (error.status === 401) return true;

            if (error.status === 429 || isQuotaOrCooldownError(error))
              return yield* deps.hasAlternative(input, pinnedId);

            return false;
          });

        const selectedOutcome = () =>
          selected === undefined
            ? undefined
            : {
                authId: selected.id,
                provider: selected.provider,
                websockets:
                  isWebsocketProvider(selected.provider) && codexWebsocketsEnabled(selected),
              };

        /**
         * The upstream socket was lost, or a continuation was refused because of it (`UpstreamWebsocketTurnError`): the
         * client socket stays open. The error frame correlates to the client frame, the operations that lost their outcome
         * with it follow, the input read before the loss is fenced and the credential stays pinned.
         */
        const reportTurnError = (error: ExecutionError): void => {
          const mainEventId = !duplexStream() || !responsesStarted ? eventIdOf(frame) : "";

          if (!lostWhileIdle) write(withEventId(buildErrorPayload(error), mainEventId));

          for (const operation of abandonedOf(error))
            write(withEventId(buildErrorPayload(abandonedError(operation)), operation.eventId));

          if (isUpstreamLost(error) && epoch === startEpoch) epoch += 1;
          commitLoss(state, { modelName: plan.modelName, selected: selectedOutcome() });
        };

        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Effect.result(deps.execute(input));

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
              // A steering socket that drops between two responses ends no request of the client's.
              lostWhileIdle = duplexStream() && responsesStarted && runningId === "";
              hasTurnInFlight = false;
              interruptSignal = undefined;
              runningId = "";
              localOpen = false;
            }),
          ),
        );

        if (result.duplexClosed === true) {
          closeSocket(1000, "");

          return true;
        }

        if (result.error !== undefined) {
          if (isUpstreamTurnError(result.error)) {
            reportTurnError(result.error);

            return false;
          }

          if (yield* replayPinnedFailure(result.error)) {
            closeSocket(1012, "upstream requires HTTP replay");
          } else terminate(result.error, result.payload);

          return true;
        }

        // The boundary stands on the compaction item the turn answered with: without it (a response cut short) the history
        // would be lost, so such a turn is recorded like any other.
        const local =
          attemptReport.local && inputContainsFullTranscript([...result.completedOutput]);

        repaired.turn?.commit();
        commitTurn(state, {
          modelName: plan.modelName,
          executedRequest: local
            ? localBoundaryRequest(requestJson)
            : nativePassthrough
              ? state.lastRequest
              : requestJson,
          local,
          selected: selectedOutcome(),
          // Upstream output is replayed as input later: its output-only fields must not travel with it (9037d543).
          completedOutput: result.completedOutput.map((item) =>
            isJsonObject(item) ? stripReplayOutputOnlyFields(item) : item,
          ),
          completedResponseId: result.completedResponseId,
          pendingToolCallIds: result.pendingToolCallIds,
        });

        return false;
      });

      // --- main loop -----------------------------------------------------------------------------------------------
      while (true) {
        if (closed) return;
        const next = yield* handOff;

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
        } else if (yield* executeTurn(plan, payload)) {
          return;
        }
      }
    }),
  );

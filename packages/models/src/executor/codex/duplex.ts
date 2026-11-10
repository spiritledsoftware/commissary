/**
 * Codex WebSocket full duplex / response steering (`upstream.codex.response-steering`).
 *
 * Go source: internal/runtime/executor/codex_websockets_duplex.go (`streamCodexDuplex`, `codexDuplexConnectionError`),
 * wired from codex_websockets_stream.go (ExecuteStream) and sdk/cliproxy/executor/websocket_input.go.
 *
 * The executor owns the upstream socket until the downstream socket goes away. A terminal event of one response is not a
 * connection terminal event: accepted steering (`response.steer`) may produce an automatic successor response or wait for
 * client tool results. There is no redial, credential selection, local acknowledgement or replay here; only the upstream can
 * take ownership of a steering submission. Steering acknowledgements, pending notifications and failures are opaque: their
 * text is forwarded untouched.
 *
 * Two fibers share the bookkeeping (plain mutable state: one JS thread, wake-ups through queues):
 *  - the writer pumps client frames (`WebsocketDuplex.next`) once the first response is established, queueing creates
 *    while steering is unacknowledged and forwarding `response.steer` straight to the upstream socket;
 *  - the reader turns upstream events into chunks, classifies failures per response and keeps the per-response settings
 *    (reasoning replay scope, native output, collaboration-tool renaming) that automatic successors inherit.
 *
 * Deviations from Go: usage of all responses of the socket is summed into the attempt's single usage record (Go publishes one
 * record per response); `WebsocketDuplex.authEnabled` defaults to true (no live credential lookup); the replay-required check
 * against a changed upstream URL is moot (the credential and so the URL are fixed for the socket).
 */
import {
  type Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Queue,
  Result,
  type Scope,
  Stream,
} from "effect";
import {
  asString,
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { emptyUsageDetail, responseModelOf, type UsageDetail } from "../../usage/record.ts";
import { isResponsesTokenEvent } from "../../usage/ttft.ts";
import { ExecutionError } from "../errors.ts";
import { restoreCodexMultiAgentV2Response } from "../helps/codex-multi-agent-v2.ts";
import { finalizePayload } from "../helps/payload.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import type { Thinking } from "../thinking.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  WebsocketDuplex,
} from "../types.ts";
import {
  type AbandonedOperation,
  isUpstreamLost,
  replayRequiredError,
  type Turn,
  withAbandoned,
} from "../websocket/session.ts";
import { codexTerminalFailure, isThinkingSignatureInvalid } from "./errors.ts";
import type { PreparedRequest } from "./executor.ts";
import {
  ensureResponsesUsageDetails,
  normalizeCodexCompletion,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput,
} from "./output.ts";
import {
  type CodexReplayScope,
  type CodexReplayStore,
  cacheReplayFromCompleted,
} from "./replay.ts";

const DISABLED_MESSAGE = "websocket credential is no longer enabled";

/** Most queued explicit creates and retained response settings (Go: 16 each). */
const MAX_OUTSTANDING = 16;

/**
 * Connection failures must not cool the shared credential (`codexDuplexConnectionError.IsRequestScoped`): the socket still
 * fails visibly, with the status and code of its cause.
 */
export const duplexConnectionError = (
  cause: ExecutionError | string,
  /** A lost upstream socket takes these operations with it (they are reported to the client next to the loss). */
  abandoned: ReadonlyArray<AbandonedOperation> = [],
): ExecutionError => {
  if (typeof cause === "string") {
    return new ExecutionError({
      status: 500,
      code: "transient_transport",
      message: cause,
      requestScoped: true,
    });
  }

  const error = new ExecutionError({
    status: cause.status,
    ...(cause.code !== undefined ? { code: cause.code } : {}),
    message: cause.message,
    ...(cause.headers !== undefined ? { headers: cause.headers } : {}),
    requestScoped: true,
  });

  return isUpstreamLost(cause) ? withAbandoned(error, abandoned) : error;
};

/** What a response needs from its request after the request itself is gone (Go: the retained `snapshot`). */
interface Settings {
  readonly replayScope: CodexReplayScope;
  readonly nativeOutput: boolean;
  readonly multiAgentV2: boolean;
  readonly reasoning: Json | undefined;
  readonly instructions: Json | undefined;
  /** The client's own `instructions` (only the initial request keeps its original payload). */
  readonly originalInstructions: Json | undefined;
  /** `event_id` of the client frame the request came from (an error about it is correlated to it). */
  readonly eventId: string;
}

const settingsOf = (
  prepared: PreparedRequest,
  original: Json | undefined,
  eventId = "",
): Settings => ({
  replayScope: prepared.replayScope,
  nativeOutput: prepared.nativeOutput,
  multiAgentV2: prepared.multiAgentV2,
  reasoning: get(prepared.body, "reasoning"),
  instructions: get(prepared.body, "instructions"),
  originalInstructions: get(original, "instructions"),
  eventId,
});

/** Retained copy: reasoning and instructions only, no request history or authorization headers. */
const snapshotOf = (settings: Settings): Settings => ({
  ...settings,
  originalInstructions: undefined,
});

type Inbox = Data.TaggedEnum<{
  wake: {};
  frame: { readonly text: string };
  end: {};
  error: { readonly error: ExecutionError };
}>;

const InboxEvent = Data.taggedEnum<Inbox>();

const addUsage = (total: UsageDetail | undefined, next: UsageDetail): UsageDetail => {
  const base = total ?? emptyUsageDetail;

  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    reasoningTokens: base.reasoningTokens + next.reasoningTokens,
    cachedTokens: base.cachedTokens + next.cachedTokens,
    cacheReadTokens: base.cacheReadTokens + next.cacheReadTokens,
    cacheCreationTokens: base.cacheCreationTokens + next.cacheCreationTokens,
    totalTokens: base.totalTokens + next.totalTokens,
    ...(next.responseServiceTier !== undefined
      ? { responseServiceTier: next.responseServiceTier }
      : {}),
  };
};

export interface DuplexParams {
  readonly prepare: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly compact: boolean; readonly websocket: boolean },
  ) => Effect.Effect<PreparedRequest, ExecutionError, Thinking>;
  readonly replayStore: CodexReplayStore;
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly duplex: WebsocketDuplex;
  /** The established turn: its first frame (`response.create`) has been written. */
  readonly turn: Turn;
  readonly initial: PreparedRequest;
  readonly modelLevelCooling: boolean;
  /** `frameCodexWebsocketRequestBody` and `parseCodexWebsocketErrorWithCooling` (injected: they live in `websocket.ts`). */
  readonly frame: (body: Json) => string;
  readonly parseWebsocketError: (
    event: Json | undefined,
    options: { readonly modelLevelCooling: boolean; readonly nowMs: number },
  ) => { readonly error: ExecutionError; readonly body: string } | undefined;
}

/**
 * Starts the writer and reader fibers (scoped to the stream) and returns the chunk stream. Chunks are bare JSON event texts;
 * the stream ends when the downstream socket is gone and fails when the connection or a credential fails.
 */
export const startCodexDuplex = (
  params: DuplexParams,
): Effect.Effect<Stream.Stream<string, ExecutionError>, never, Scope.Scope | Thinking> =>
  Effect.gen(function* () {
    const { context, request, options, duplex, turn, initial } = params;
    const out = yield* Queue.unbounded<string, ExecutionError | Cause.Done>();
    const changed = yield* Queue.sliding<void>(1);
    const inbox = yield* Queue.unbounded<Inbox>();
    const inputReady = yield* Deferred.make<void>();

    const initialSettings = settingsOf(initial, request.payload);
    // Explicit creates have their own settings; automatic successors inherit the preceding response's.
    const pending: Settings[] = [initialSettings];
    const unacknowledgedSteers: string[] = [];
    const acceptedSteers = new Map<string, string>();
    const responseSettings = new Map<string, Settings>();
    const steeringSettings = new Map<string, Settings>();
    const responseOrder: string[] = [];
    const pendingCreates: string[] = [];
    let current = initialSettings;
    let responseId = "";
    let waitingParent = "";
    let automaticActive = false;
    let responseActive = false;
    let connectionMultiAgentV2 = initialSettings.multiAgentV2;
    let finished = false;

    const wake = (): void => {
      Queue.offerUnsafe(changed, undefined);
      Queue.offerUnsafe(inbox, InboxEvent.wake());
    };

    const finish = (error: ExecutionError | undefined): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (finished) return Effect.void;
        finished = true;

        return (error === undefined ? Queue.end(out) : Queue.fail(out, error)).pipe(Effect.asVoid);
      });

    const emit = (chunk: string): Effect.Effect<void> =>
      Queue.offer(out, chunk).pipe(Effect.asVoid);

    const waitFor = (ready: () => boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (!ready()) yield* Queue.take(changed);
      });

    const releaseSteeringSettings = (parent: string): void => {
      if (unacknowledgedSteers.includes(parent)) return;

      for (const target of acceptedSteers.values()) if (target === parent) return;
      steeringSettings.delete(parent);
    };

    const readyForCreate = (): boolean => {
      if (unacknowledgedSteers.length > 0 || automaticActive) return false;

      for (const parent of acceptedSteers.values()) if (parent !== waitingParent) return false;

      return true;
    };

    /**
     * The operations the client has been told nothing about that a lost upstream socket takes with it (Go `Abandoned`):
     * creates still queued here were never written, creates written and not yet started lost their outcome. The first
     * response's request is the handler's own and is not listed.
     */
    const abandonedOperations = (): AbandonedOperation[] => [
      ...pendingCreates.map((text): AbandonedOperation => {
        const frame = tryParseJson(text);
        const eventId = asString(get(frame, "event_id")).trim();

        const continuation =
          asString(get(frame, "previous_response_id")).trim() !== "" ||
          asString(get(frame, "type")) === "response.append";

        return { eventId, outcome: continuation ? "continuation" : "not_sent" };
      }),
      ...pending.flatMap((settings): AbandonedOperation[] =>
        settings === initialSettings ? [] : [{ eventId: settings.eventId, outcome: "lost" }],
      ),
    ];

    const credentialEnabled = (): boolean => duplex.authEnabled?.(context.credential.id) !== false;

    // --- writer ---------------------------------------------------------------------------------------------------
    const reject = (message: string): Effect.Effect<void> =>
      emit(
        JSON.stringify({
          error: { message, type: "invalid_request_error" },
          status: 400,
          type: "error",
        }),
      );

    /** Writes a frame upstream; a failure ends the socket. Returns false when the writer must stop. */
    const write = (frame: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (!credentialEnabled()) {
          yield* finish(duplexConnectionError(DISABLED_MESSAGE));

          return false;
        }

        const sent = yield* Effect.result(turn.send(frame));

        if (Result.isFailure(sent)) {
          yield* finish(duplexConnectionError(sent.failure, abandonedOperations()));

          return false;
        }

        return true;
      });

    const processCreate = (text: string): Effect.Effect<boolean, never, Thinking> =>
      Effect.gen(function* () {
        let payload = tryParseJson(text);

        if (!isJsonObject(payload)) return true;
        const isAppend = asString(payload["type"]) === "response.append";
        let previous = asString(payload["previous_response_id"]).trim();

        if (isAppend && previous === "" && responseId !== "") {
          previous = responseId;
          payload = set(payload, "previous_response_id", previous);
        }

        if (acceptedSteers.size > 0 && previous !== waitingParent) {
          yield* reject("response.create must continue the response waiting for required input");

          return true;
        }

        const originalModel = asString(get(request.payload, "model"));
        let model = asString(get(payload, "model")).trim();

        if (model !== "" && model !== request.model && model !== originalModel) {
          yield* finish(duplexConnectionError(replayRequiredError()));

          return false;
        }

        if (model === "") {
          model = request.model !== "" ? request.model : originalModel.trim();
          payload = set(payload, "model", model);
        }

        if (isAppend && get(payload, "instructions") === undefined) {
          const target = responseSettings.get(previous) ?? initialSettings;
          let instructions = target.instructions ?? target.originalInstructions;
          instructions ??= initialSettings.instructions ?? initialSettings.originalInstructions;

          if (instructions !== undefined)
            payload = set(payload, "instructions", cloneJson(instructions));
        }

        const prepared = yield* Effect.result(
          params.prepare(
            context,
            { ...request, payload },
            { ...options, originalRequest: payload },
            { stream: true, compact: false, websocket: true },
          ),
        );

        if (Result.isFailure(prepared)) {
          yield* finish(duplexConnectionError(prepared.failure));

          return false;
        }

        if (pending.length >= MAX_OUTSTANDING) {
          yield* finish(duplexConnectionError("too many outstanding response.create requests"));

          return false;
        }

        pending.push(
          settingsOf(prepared.success, undefined, asString(get(payload, "event_id")).trim()),
        );

        if (prepared.success.multiAgentV2) connectionMultiAgentV2 = true;

        return yield* write(params.frame(prepared.success.body));
      });

    const flushPendingCreates = (): Effect.Effect<boolean, never, Thinking> =>
      Effect.gen(function* () {
        while (pendingCreates.length > 0 && readyForCreate()) {
          const next = pendingCreates.shift();

          if (next === undefined) return true;

          if (!(yield* processCreate(next))) return false;
        }

        return true;
      });

    const processSteer = (payloadValue: JsonObject): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        // Steering carries business input but must not inherit response.create defaults.
        const original = cloneJson(payloadValue);

        const finalized = finalizePayload(
          context.config,
          "codex-websockets",
          {
            model: parseSuffix(request.model).modelName,
            requestedModel:
              options.metadata.requestedModel !== ""
                ? options.metadata.requestedModel
                : request.model,
            protocol: "codex",
            fromProtocol: options.sourceFormat,
            requestPath: options.metadata.requestPath,
            headers: options.headers,
            original,
          },
          payloadValue,
        );

        const body = set(finalized, "type", "response.steer");
        const parent = asString(get(body, "previous_response_id"));
        let settings = responseSettings.get(parent);

        if (settings === undefined) {
          yield* waitFor(() => pending.length === 0);
          settings = responseSettings.get(parent);
        }

        unacknowledgedSteers.push(parent);

        if (settings !== undefined) steeringSettings.set(parent, settings);

        // Control frames bypass response.create translations and built-in defaults; upstream validates the rest.
        return yield* write(JSON.stringify(body));
      });

    const handleFrame = (text: string): Effect.Effect<boolean, never, Thinking> =>
      Effect.gen(function* () {
        if (!credentialEnabled()) {
          // A fresh client connection can select an enabled credential: never send this frame on a disabled account.
          yield* finish(duplexConnectionError(DISABLED_MESSAGE));

          return false;
        }

        const parsed = tryParseJson(text);

        if (!isJsonObject(parsed)) {
          yield* reject("invalid websocket request JSON");

          return true;
        }

        switch (asString(parsed["type"])) {
          case "response.steer":
            return yield* processSteer(parsed);
          case "response.create":
          case "response.append":
            if (pendingCreates.length === 0 && readyForCreate()) return yield* processCreate(text);

            if (pendingCreates.length >= MAX_OUTSTANDING) {
              yield* finish(duplexConnectionError("too many outstanding response.create requests"));

              return false;
            }

            pendingCreates.push(text);

            return true;
          default:
            yield* reject(`unsupported websocket request type: ${asString(parsed["type"])}`);

            return true;
        }
      });

    // Do not consume follow-ups until bootstrap succeeds: a rejected initial request may retry on another credential
    // with the same input source.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Deferred.await(inputReady);
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const next = yield* Effect.result(duplex.next);

              if (Result.isFailure(next))
                return Queue.offerUnsafe(inbox, InboxEvent.error({ error: next.failure }));

              if (next.success === undefined) return Queue.offerUnsafe(inbox, InboxEvent.end());
              Queue.offerUnsafe(inbox, InboxEvent.frame({ text: next.success }));
            }
          }),
        );

        while (true) {
          if (!(yield* flushPendingCreates())) return;
          const item = yield* Queue.take(inbox);

          if (InboxEvent.$is("wake")(item)) continue;

          if (InboxEvent.$is("end")(item)) return yield* finish(undefined);

          if (InboxEvent.$is("error")(item)) return yield* finish(item.error);

          if (!(yield* handleFrame(item.text))) return;
        }
      }),
    );

    // --- reader ---------------------------------------------------------------------------------------------------
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let firstResponse = true;
        let collector = new OutputItemCollector();
        let totalUsage: UsageDetail | undefined;

        while (true) {
          const read = yield* Effect.result(turn.read);

          if (Result.isFailure(read)) {
            if (!finished)
              yield* finish(duplexConnectionError(read.failure, abandonedOperations()));

            return;
          }

          const text = read.success;
          const nowMs = yield* Clock.currentTimeMillis;
          const event = tryParseJson(text);
          const eventType = asString(get(event, "type"));
          const establishing = firstResponse && eventType === "response.created";

          if (eventType === "response.created") {
            const previousId = asString(get(event, "response.previous_response_id"));
            const parent = previousId !== "" ? previousId : responseId;

            if (!firstResponse && pending.length === 0) {
              const settings = steeringSettings.get(parent) ?? responseSettings.get(parent);

              if (settings === undefined) {
                yield* finish(
                  duplexConnectionError("automatic successor has no retained parent settings"),
                );

                return;
              }

              current = settings;
            }

            for (const [id, target] of acceptedSteers)
              if (target === parent) acceptedSteers.delete(id);
            waitingParent = "";
            automaticActive = !firstResponse && pending.length === 0;

            const nextSettings = pending.length > 0 ? pending.shift() : undefined;

            if (nextSettings !== undefined) current = nextSettings;
            responseId = asString(get(event, "response.id"));
            // Retain response settings, not request history or authorization headers. In-flight steering pins its
            // parent's settings independently of this window.
            responseSettings.set(responseId, snapshotOf(current));
            responseOrder.push(responseId);

            const oldestResponse =
              responseOrder.length > MAX_OUTSTANDING ? responseOrder.shift() : undefined;

            if (oldestResponse !== undefined) responseSettings.delete(oldestResponse);
            releaseSteeringSettings(parent);
            wake();

            if (!firstResponse) {
              const effort = asString(get(current.reasoning, "effort"));

              if (effort !== "") context.usage.setReasoningEffort(effort);
            }

            firstResponse = false;
            responseActive = true;
            collector = new OutputItemCollector();
          }

          context.usage.observeResponseModel(responseModelOf(event));

          if (!context.usage.ttftObserved)
            context.usage.observeTokenEvent(nowMs, isResponsesTokenEvent(text));

          // Steering acknowledgements, pending notifications and failures are opaque: preserve ids, input, sequence
          // numbers and event types byte-for-byte.
          if (eventType.startsWith("response.steer.")) {
            const id = asString(get(event, "steer.id"));
            const previousId = asString(get(event, "steer.previous_response_id"));
            const parent = previousId !== "" ? previousId : responseId;

            const consumeSubmission = (): void => {
              const index = unacknowledgedSteers.findIndex(
                (target) => target === parent || target === "",
              );

              if (index >= 0) unacknowledgedSteers.splice(index, 1);
            };

            switch (eventType) {
              case "response.steer.accepted":
                consumeSubmission();
                acceptedSteers.set(id, parent);
                break;
              case "response.steer.failed":
                if (acceptedSteers.has(id)) acceptedSteers.delete(id);
                else consumeSubmission();
                releaseSteeringSettings(parent);
                break;
              case "response.steer.pending":
                // Tool results may already be waiting in the writer. No automatic successor can start until an
                // explicit continuation supplies them.
                waitingParent = parent;
                break;
            }

            wake();
            yield* emit(text);
            continue;
          }

          const wsFailure = params.parseWebsocketError(event, {
            modelLevelCooling: params.modelLevelCooling,
            nowMs,
          });

          const terminal =
            wsFailure ??
            codexTerminalFailure(event, { modelLevelCooling: params.modelLevelCooling, nowMs });

          if (!firstResponse && (eventType === "error" || eventType === "response.failed")) {
            const credentialStatus = terminal?.error.status;

            if (credentialStatus === 401 || credentialStatus === 403 || credentialStatus === 429) {
              // Account health is independent of which queued request failed. The conductor records the original
              // classification without replaying this already-started stream on another credential.
              context.usage.fail(terminal?.error.status ?? 500, terminal?.error.message ?? "");
              yield* emit(text);
              yield* finish(terminal?.error);

              return;
            }
          }

          let eventSettings = current;

          if (!firstResponse && (eventType === "response.failed" || eventType === "error")) {
            const failedId =
              asString(get(event, "response.id")) !== ""
                ? asString(get(event, "response.id"))
                : asString(get(event, "response_id"));

            // A failure for the running response must not consume a queued create. A rejection before response.created
            // instead owns the oldest pending create, including its reasoning replay scope.
            const currentFailure = failedId !== "" && failedId === responseId;

            const ambiguous =
              failedId === "" &&
              ((pending.length > 0 && responseActive) || unacknowledgedSteers.length > 0);

            const queuedSettings =
              pending.length > 0 && !currentFailure && !ambiguous ? pending.shift() : undefined;

            if (queuedSettings !== undefined) {
              eventSettings = queuedSettings;
            } else if (!ambiguous) {
              responseActive = false;
              automaticActive = false;
            }

            wake();

            if (ambiguous) {
              // Without a response id, assigning this failure could corrupt either request: preserve the event and fail
              // the socket without guessing a scope, replaying input or cooling the credential.
              yield* emit(text);
              yield* finish(
                duplexConnectionError(
                  "cannot associate websocket failure with a response or pending create",
                ),
              );

              return;
            }
          }

          const restore = eventSettings.multiAgentV2 || connectionMultiAgentV2;
          const normalized = restoreCodexMultiAgentV2Response(text, restore);
          const parsed = tryParseJson(normalized);

          // Invalidate replay for every rejected request, with the settings that belong to this event.
          if (terminal !== undefined) {
            if (isThinkingSignatureInvalid(terminal.error.status, terminal.error.message)) {
              yield* params.replayStore.clear(
                eventSettings.replayScope.modelName,
                eventSettings.replayScope.sessionKey,
              );
            }

            context.usage.fail(terminal.error.status, terminal.error.message);

            if (firstResponse) {
              yield* finish(terminal.error);

              return;
            }
          }

          if (eventType === "response.output_item.done") collector.collect(parsed);
          let chunk = normalized;

          if (
            (eventType === "response.completed" ||
              eventType === "response.done" ||
              eventType === "response.incomplete") &&
            isJsonObject(parsed)
          ) {
            responseActive = false;
            automaticActive = false;
            wake();
            const completed = normalizeCodexCompletion(parsed);

            if (!current.nativeOutput) patchCodexCompletedOutput(completed, collector);

            if (eventType !== "response.incomplete") {
              yield* cacheReplayFromCompleted(params.replayStore, current.replayScope, completed);
            }

            const detail = parseCodexUsage(completed);

            if (detail !== undefined) {
              totalUsage = addUsage(totalUsage, detail);
              context.usage.publish(totalUsage);
            }

            chunk = JSON.stringify(completed);
          }

          yield* emit(chunk.includes('"usage"') ? ensureResponsesUsageDetails(chunk) : chunk);

          if (establishing) {
            // Deliver response.created before any locally generated error so the downstream handler also observes a
            // successful bootstrap first.
            yield* Deferred.succeed(inputReady, undefined);
          }
        }
      }),
    );

    return Stream.fromQueue(out);
  });

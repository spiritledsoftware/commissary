/**
 * Response side of the executors whose `/responses` upstream always streams (Meta, OpenCode Zen/Go): the SSE answer
 * aggregated into one non-stream response, or translated event by event.
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (Execute: `translateMetaCompleted`,
 * `metaAsCompletedEvent`), meta_executor_stream.go (ExecuteStream). Non-stream callers get the terminal
 * `response.completed`/`response.incomplete` event with the collected output items; the apply_patch Responses bridge
 * wraps the event flow (`helps/apply-patch-responses.ts`). The provider supplies how `error`/`response.failed` events
 * become upstream errors and the stall message of a stream that ends without a terminal event.
 */
import { Clock, Effect, Stream } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { splitLines } from "@commissary/translation/sse";
import {
  asString,
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import {
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "@commissary/translation";
import { responseModelOf } from "../../usage/record.ts";
import { isResponsesTokenEvent } from "../../usage/ttft.ts";
import {
  ensureResponsesUsageDetails,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput,
} from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  StreamResult,
} from "../types.ts";
import { APPLY_PATCH_UPSTREAM_ERROR_MESSAGE } from "./apply-patch-responses.ts";
import type { ResponsesPrepared } from "./responses-request.ts";

interface StepResult {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
}

export interface ResponsesSseInput {
  readonly registry: TranslatorRegistry;
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly prepared: ResponsesPrepared;
  readonly response: HttpClientResponse.HttpClientResponse;
  /** `error` / `response.failed` events as upstream errors (`undefined` for any other event). */
  readonly eventError: (
    event: Json | undefined,
    payload: string,
    nowMs: number,
  ) => ExecutionError | undefined;
  /** Error message (408) of an answer without `response.completed`/`response.incomplete`. */
  readonly stallMessage: string;
  /** A fresh stateful line filter per answer (Meta drops `response.subscription_usage` frames). */
  readonly lineFilter?: () => SseLineFilter;
}

/** Stateful SSE line filter: `push` returns the lines to keep (possibly held back), `flush` the held ones at EOF. */
export interface SseLineFilter {
  push(line: string): string[];
  flush(): string[];
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

const gatewayError = () =>
  new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE });

const responseContext = (input: ResponsesSseInput): ResponseContext => ({
  model: input.request.model,
  originalRequest: input.options.originalRequest ?? input.request.payload,
  translatedRequest: input.prepared.translated,
  state: makeTranslationState(),
});

/** `metaAsCompletedEvent`: a plain JSON response body is wrapped as a `response.completed` event. */
const asCompletedEvent = (data: string): JsonObject | undefined => {
  const root = tryParseJson(data.trim());

  if (!isJsonObject(root)) return undefined;
  const type = asString(root["type"]);

  if (type === "response.completed" || type === "response.incomplete") return root;

  if (asString(root["object"]) === "response" || root["output"] !== undefined) {
    return { type: "response.completed", response: root };
  }

  return undefined;
};

/** Non-stream answer: the terminal event (output items patched in), translated to the client format. */
export const collectResponsesSse = Effect.fnUntraced(function* (
  input: ResponsesSseInput,
): Effect.fn.Return<ExecutorResponse, ExecutionError> {
  const { registry, context, prepared, response } = input;
  const data = yield* response.text.pipe(Effect.mapError(transportError));
  context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
  const collector = new OutputItemCollector();
  const nowMs = yield* Clock.currentTimeMillis;
  let completed: JsonObject | undefined;

  const filter = input.lineFilter?.();
  const lines = data.split("\n");

  for (const line of filter === undefined ? lines : lines.flatMap((item) => filter.push(item))) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    const parsed = tryParseJson(payload);
    const failure = input.eventError(parsed, payload, nowMs);

    if (failure !== undefined) {
      context.usage.fail(failure.status, failure.message);

      return yield* failure;
    }

    if (parsed === undefined) continue;
    const bridged = prepared.applyPatch.transform(parsed);

    if (bridged.error !== undefined) return yield* gatewayError();

    for (const event of bridged.events) {
      const type = asString(get(event, "type"));

      if (type === "response.output_item.done") collector.collect(event);
      else if (
        (type === "response.completed" || type === "response.incomplete") &&
        isJsonObject(event)
      ) {
        completed = event;
        break;
      }
    }

    if (completed !== undefined) break;
  }

  let event: JsonObject;

  if (completed === undefined) {
    const fallback = asCompletedEvent(data);

    if (fallback === undefined) {
      // `Finish`: an unvalidated apply_patch call is a gateway failure before the stall error.
      if (prepared.applyPatch.finish() !== undefined) return yield* gatewayError();
      const error = new ExecutionError({ status: 408, message: input.stallMessage });
      context.usage.fail(error.status, error.message);

      return yield* error;
    }

    event = cloneJson(fallback);
    patchCodexCompletedOutput(event, collector);
    const bridged = prepared.applyPatch.bridge.transformNonStream(event);

    if ("error" in bridged || !isJsonObject(bridged.body)) return yield* gatewayError();
    event = bridged.body;
  } else {
    event = cloneJson(completed);

    if (isJsonObject(event)) patchCodexCompletedOutput(event, collector);
  }

  let out = registry.translateNonStream(
    prepared.responseFormat,
    Formats.Codex,
    responseContext(input),
    JSON.stringify(event),
  );

  if (out === undefined || out === "") {
    return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
  }

  const detail = parseCodexUsage(event);

  if (detail !== undefined) context.usage.publish(detail);

  if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

  return { payload: out, headers: new Headers(response.headers) };
});

/** Stream answer: every event through the apply_patch bridge and the translator, usage from the terminal event. */
export const streamResponsesSse = (input: ResponsesSseInput): StreamResult => {
  const { registry, context, prepared, response } = input;
  const collector = new OutputItemCollector();
  const state = responseContext(input);

  const translate = (line: string): string[] => {
    const chunks = [
      ...registry.translateStream(prepared.responseFormat, Formats.Codex, state, line),
    ];

    return prepared.responseFormat === Formats.OpenAIResponse
      ? chunks.map((chunk) => ensureResponsesUsageDetails(chunk))
      : chunks;
  };

  /** `emitTranslatedLine`: the apply_patch bridge first, then the translator; a retained failure ends the stream. */
  const emit = (line: string): StepResult => {
    const bridged = prepared.applyPatch.stream(line);
    const chunks = bridged.lines.flatMap(translate);
    const failed = bridged.error !== undefined || state.state.toolInputError !== undefined;

    return { chunks, ...(failed ? { error: gatewayError() } : {}) };
  };

  let stopped = false;

  const filter = input.lineFilter?.();

  const filtered = splitLines(response.stream).pipe(
    Stream.mapError(transportError),
    filter === undefined
      ? (stream) => stream
      : (stream) =>
          Stream.concat(
            Stream.flatMap(stream, (line) => Stream.fromIterable(filter.push(line))),
            Stream.suspend(() => Stream.fromIterable(filter.flush())),
          ),
  );

  const lines = filtered.pipe(
    Stream.mapEffect((line) =>
      Effect.gen(function* () {
        if (stopped) return { chunks: [] };

        if (!line.startsWith("data:")) return emit(line);
        const payload = line.slice(5).trim();
        const event = tryParseJson(payload);

        // The effective TTFT is the first token event, observed before translation or failure publication.
        if (!context.usage.ttftObserved)
          context.usage.observeTokenEvent(
            yield* Clock.currentTimeMillis,
            isResponsesTokenEvent(line),
          );
        context.usage.observeResponseModel(responseModelOf(event));
        const failure = input.eventError(event, payload, yield* Clock.currentTimeMillis);

        if (failure !== undefined) return yield* failure;

        switch (asString(get(event, "type"))) {
          case "response.output_item.done":
            collector.collect(event);
            break;
          case "response.completed":
          case "response.incomplete": {
            if (!isJsonObject(event)) break;
            const detail = parseCodexUsage(event);

            if (detail !== undefined) context.usage.publish(detail);
            patchCodexCompletedOutput(event, collector);

            return emit(`data: ${JSON.stringify(event)}`);
          }
        }

        return emit(`data: ${payload}`);
      }),
    ),
    Stream.tap((step) =>
      Effect.sync(() => {
        if (step.error !== undefined) stopped = true;
      }),
    ),
  );

  // `FinishStream`: EOF without a validated completion emits the local failure once.
  const tail = Stream.suspend(() => {
    if (stopped) return Stream.empty;
    const finished = prepared.applyPatch.finishStream();
    const chunks = finished.lines.flatMap(translate);
    const emitted = Stream.fromIterable(chunks);

    return finished.error === undefined
      ? emitted
      : Stream.concat(emitted, Stream.fail(gatewayError()));
  });

  const chunks = Stream.concat(
    lines.pipe(
      Stream.takeUntil((step) => step.error !== undefined),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks);

        return step.error === undefined ? emitted : Stream.concat(emitted, Stream.fail(step.error));
      }),
    ),
    tail,
  ).pipe(
    Stream.filter((chunk) => chunk.length > 0),
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks };
};

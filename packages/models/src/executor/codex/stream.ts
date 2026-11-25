/**
 * Line-by-line Codex SSE stream processing.
 *
 * Go source: internal/runtime/executor/codex_executor_stream.go (ExecuteStream reader loop and the bootstrap
 * buffering loop). Each upstream line is observed (usage, response model, output items, terminal failures), then
 * translated to the client format. `data:` payloads are forwarded as received; only the terminal event is
 * re-serialised (`response.done` renamed, `response.output` patched).
 *
 * Bootstrap buffering (`options.bootstrap`, see `bootstrap.ts`): handshake frames are held back until the first real
 * event. An overload/rate-limit rejection seen while holding fails the attempt (503) before anything is released; any
 * other terminal failure releases the held frames and is delivered in-stream; a clean EOF while holding fails the
 * attempt without releasing. The frame/byte/time budgets release the stream without further probing.
 */
import { restoreCodexMultiAgentV2Response } from "../helps/codex-multi-agent-v2.ts";
import {
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import type { ResponseContext, TranslatorRegistry } from "@commissary/translation";
import { responseModelOf } from "../../usage/record.ts";
import type { UsageReporter } from "../../usage/reporter.ts";
import { isResponsesTokenEvent } from "../../usage/ttft.ts";
import type { ExecutionError } from "../errors.ts";
import {
  codexClosedBeforeFirstPayloadError,
  codexEmptyIncompleteStreamError,
  codexIncompleteStreamError,
  codexTerminalFailure,
} from "./errors.ts";
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  normalizeCodexCompletion,
  OutputItemCollector,
  parseCodexUsage,
  publishCodexImageToolUsage,
  patchCodexCompletedOutput,
} from "./output.ts";
import {
  BOOTSTRAP_MAX_BUFFERED_BYTES,
  BOOTSTRAP_MAX_BUFFERED_FRAMES,
  bootstrapOverloadError,
  isBootstrapBufferableEvent,
  isOverloadBootstrapFailure,
} from "./bootstrap.ts";
import type { CodexReplayScope } from "./replay.ts";

export interface CodexStreamStep {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
  /** Stop reading (terminal event or failure). */
  readonly stop: boolean;
  /** A completed event whose reasoning/tool calls should be cached for replay. */
  readonly cacheCompleted?: Json;
  /** Failure body/status that may require clearing the replay cache. */
  readonly failureBody?: { readonly status: number; readonly body: string };
}

export interface CodexStreamOptions {
  readonly registry: TranslatorRegistry;
  /** Client protocol of the response. */
  readonly responseFormat: string;
  /** Provider format of the upstream (`codex`). */
  readonly providerFormat: string;
  readonly context: ResponseContext;
  readonly usage: UsageReporter;
  /** Native Codex clients receive the upstream output untouched. */
  readonly preserveNativeOutput: boolean;
  /** The request body (the `image_generation` tool model of additional image-tool usage records). */
  readonly requestBody?: Json | undefined;
  readonly modelLevelCooling: boolean;
  readonly nowMs: () => number;
  readonly replayScope: CodexReplayScope;
  /** The request was optimised for multi-agent v2: restore the collaboration namespace in every event. */
  readonly multiAgentV2?: boolean;
  /** Hold back handshake frames (`stream-bootstrap-buffering`); `timeoutMs` 0 = no time budget. */
  readonly bootstrap?: { readonly timeoutMs: number } | undefined;
  /** Grok clients (`grok-pager`/`grok-shell` User-Agent) get keepalive events as SSE comments. */
  readonly grokClient?: boolean;
}

/** `grokbuild.IsKeepaliveSSELine`. */
const isKeepaliveLine = (line: string): boolean => {
  const trimmed = line.trim();

  if (trimmed.startsWith("event:")) return trimmed.slice(6).trim() === "keepalive";

  if (trimmed.startsWith("data:"))
    return asString(get(tryParseJson(trimmed.slice(5).trim()), "type")) === "keepalive";

  return false;
};

const KEEPALIVE_COMMENT = ": keepalive\n\n";

/** One processed line: the step and whether the line carries nothing observable yet. */
interface Processed {
  readonly step: CodexStreamStep;
  readonly handshake: boolean;
}

export class CodexStreamReader {
  readonly #collector = new OutputItemCollector();
  #sawOutputDelta = false;
  #emitted = 0;
  #stopped = false;

  constructor(readonly options: CodexStreamOptions) {
    this.#buffering = options.bootstrap !== undefined;
    this.#startMs = options.nowMs();
  }

  #translate(line: string): string[] {
    const { registry, responseFormat, providerFormat, context } = this.options;
    const chunks = [...registry.translateStream(responseFormat, providerFormat, context, line)];

    const out =
      responseFormat === Formats.OpenAIResponse
        ? chunks.map((chunk) => ensureResponsesUsageDetails(chunk))
        : chunks;

    for (const chunk of out) if (chunk.length > 0) this.#emitted++;

    return out;
  }

  #buffering: boolean;
  readonly #held: string[] = [];
  #heldFrames = 0;
  #heldBytes = 0;
  readonly #startMs: number;

  #release(step: CodexStreamStep): CodexStreamStep {
    this.#buffering = false;
    const chunks = [...this.#held, ...step.chunks];
    this.#held.length = 0;

    return { ...step, chunks };
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): CodexStreamStep {
    const { step, handshake } = this.#process(line);

    if (!this.#buffering) return step;
    const { nowMs } = this.options;
    const timeoutMs = this.options.bootstrap?.timeoutMs ?? 0;
    const timeoutReached = (): boolean => timeoutMs > 0 && nowMs() - this.#startMs >= timeoutMs;

    if (step.error !== undefined) {
      const body = step.failureBody?.body;

      if (body !== undefined && isOverloadBootstrapFailure(body) && !timeoutReached()) {
        // Transient capacity rejection inside an HTTP 200 stream: fail the attempt before the headers are committed.
        this.#buffering = false;
        this.#held.length = 0;

        return {
          ...step,
          chunks: [],
          error: bootstrapOverloadError(body, nowMs(), step.error),
          stop: true,
        };
      }

      // Every other terminal failure keeps its in-stream delivery: the held handshake goes first.
      return this.#release(step);
    }

    if (!handshake || step.stop) return this.#release(step);
    const frameBytes = line.length + step.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    if (
      !timeoutReached() &&
      this.#heldFrames < BOOTSTRAP_MAX_BUFFERED_FRAMES &&
      this.#heldBytes + frameBytes <= BOOTSTRAP_MAX_BUFFERED_BYTES
    ) {
      this.#heldFrames++;
      this.#heldBytes += frameBytes;
      this.#held.push(...step.chunks);

      return { chunks: [], stop: false };
    }

    return this.#release(step);
  }

  #process(line: string): Processed {
    if (this.#stopped) return { step: { chunks: [], stop: true }, handshake: false };

    if (this.options.grokClient === true && isKeepaliveLine(line)) {
      return { step: { chunks: this.#translate(KEEPALIVE_COMMENT), stop: false }, handshake: true };
    }

    if (!line.startsWith("data:"))
      return { step: { chunks: this.#translate(line), stop: false }, handshake: true };
    const { usage, modelLevelCooling, nowMs } = this.options;

    const payload = restoreCodexMultiAgentV2Response(
      line.slice(5).trim(),
      this.options.multiAgentV2 === true,
    );

    const parsed = tryParseJson(payload);
    usage.observeResponseModel(responseModelOf(parsed));

    if (!usage.ttftObserved) usage.observeTokenEvent(nowMs(), isResponsesTokenEvent(payload));
    const eventType = asString(get(parsed, "type"));

    const failure = codexTerminalFailure(parsed, { modelLevelCooling, nowMs: nowMs() });

    if (failure !== undefined) {
      this.#stopped = true;

      return {
        step: {
          chunks: [],
          error: failure.error,
          stop: true,
          failureBody: { status: failure.error.status, body: failure.body },
        },
        handshake: false,
      };
    }

    if (hasMeaningfulOutputDelta(parsed)) this.#sawOutputDelta = true;

    if (isTerminalEmptyIncomplete(parsed, this.#collector.count, this.#sawOutputDelta)) {
      this.#stopped = true;

      return {
        step: { chunks: [], error: codexEmptyIncompleteStreamError(), stop: true },
        handshake: false,
      };
    }

    const handshake = isBootstrapBufferableEvent(eventType, payload, parsed);

    switch (eventType) {
      case "response.output_item.done":
        this.#collector.collect(parsed);
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.done": {
        this.#stopped = true;

        if (!isJsonObject(parsed)) break;
        const event: JsonObject = normalizeCodexCompletion(parsed);
        const detail = parseCodexUsage(event);

        if (detail !== undefined) usage.publish(detail);
        publishCodexImageToolUsage(usage, this.options.requestBody, event);

        if (!this.options.preserveNativeOutput) patchCodexCompletedOutput(event, this.#collector);
        const completed = eventType === "response.completed" || eventType === "response.done";

        return {
          step: {
            chunks: this.#translate(`data: ${JSON.stringify(event)}`),
            stop: true,
            ...(completed ? { cacheCompleted: event } : {}),
          },
          handshake: false,
        };
      }
    }

    return { step: { chunks: this.#translate(`data: ${payload}`), stop: false }, handshake };
  }

  /** Clean EOF without a terminal event. */
  end(): CodexStreamStep {
    if (this.#stopped) return { chunks: [], stop: true };
    this.#stopped = true;

    const error =
      this.#emitted === 0 ? codexClosedBeforeFirstPayloadError() : codexIncompleteStreamError();

    return { chunks: [], error, stop: true };
  }
}
